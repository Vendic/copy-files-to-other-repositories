const core = require('@actions/core');
const { getOctokit } = require('@actions/github');

const { getReposList, getRepo } = require('./api-calls');
const { getListOfFilesToReplicate, getListOfReposToIgnore, getBranchName, getBranchesList } = require('./utils');
const { createBranchApi, processFilesWithApi, createPullRequestApi } = require('./github-api');

const triggerEventName = process.env.GITHUB_EVENT_NAME;
const eventPayload = require(process.env.GITHUB_EVENT_PATH);

async function run() {
  const isPush = triggerEventName === 'push';
  if (isPush) core.info('Workflow started on push event');
  const isWorkflowDispatch = triggerEventName === 'workflow_dispatch';
  if (isWorkflowDispatch) core.info('Workflow started on workflow_dispatch event');

  if (!isPush && !isWorkflowDispatch) return core.setFailed('This GitHub Action works only when triggered by "push" or "workflow_dispatch" webhooks.');
  
  core.debug('DEBUG: full payload of the event that triggered the action:');
  core.debug(JSON.stringify(eventPayload, null, 2));

  try {
    /*
     * 0. Setting up necessary variables and getting input specified by workflow user
    */ 
    const gitHubKey = process.env.GITHUB_TOKEN || core.getInput('github_token', { required: true });
    const patternsToIgnore = core.getInput('patterns_to_ignore');
    const patternsToInclude = core.getInput('patterns_to_include');
    const patternsToRemove = core.getInput('patterns_to_remove');
    const committerUsername = core.getInput('committer_username');
    const committerEmail = core.getInput('committer_email');
    const commitMessage = core.getInput('commit_message');
    const branches = core.getInput('branches');
    const destination = core.getInput('destination');
    const customBranchName = core.getInput('bot_branch_name');
    const sleepPrCreation = parseInt(core.getInput('sleep_pr_creation'), 10) || 0;
    const repoNameManual = eventPayload.inputs && eventPayload.inputs.repo_name;

    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');

    const myOctokit = getOctokit(gitHubKey, {
      // Topics are currently only available using mercy-preview.
      previews: ['mercy-preview'],
    });

    //Id of commit can be taken only from push event, not workflow_dispatch
    //TODO for now this action is hardcoded to always get commit id of the first commit on the list
    const commitId = triggerEventName === 'push' ? eventPayload.commits[0].id : '';

    if (patternsToRemove && patternsToInclude) {
      core.setFailed('Fields patterns_to_include and patterns_to_remove are mutually exclusive. If you want to remove files from repos then do not use patterns_to_include.');
      return;
    }

    if (patternsToRemove && destination) 
      core.warning('The destination field will be ignored as it doesn\'t make sense when removal is expected and patterns_to_remove field is used');

    /*
     * 1. Getting list of files that have changes that must be replicated in other repos
     * If `patterns_to_remove` field is used then this step is ommited as there is no need to search for files to replicate as no replication takes place but removal
     */
    let filesToCheckForReplication;
    let filesToReplicate;
    let filesToRemove;
    if (!patternsToRemove) {
      filesToCheckForReplication = await getListOfFilesToReplicate(myOctokit, commitId, owner, repo, patternsToIgnore, patternsToInclude, triggerEventName);
      filesToReplicate = filesToCheckForReplication.filesForReplication;
      filesToRemove = filesToCheckForReplication.filesForRemoval;
      //if no files need replication, we just need to stop the workflow from further execution
      if (!filesToReplicate.length && !filesToRemove.length) 
        return;
    } 
    //filesForReplication
    //filesThatNeedToBeRemoved

    /*
     * 2. Getting list of all repos owned by the owner/org 
     *    or just replicating to the one provided manually
     */
    let reposList = [];
    if (isWorkflowDispatch && repoNameManual) {
      reposList.push(await getRepo(myOctokit, owner, repoNameManual));
    } else {
      reposList = await getReposList(myOctokit, owner);
    }

    /*
     * 3. Getting list of repos that should be ignored
     */
    const ignoredRepositories = getListOfReposToIgnore(repo, reposList, {
      reposToIgnore: core.getInput('repos_to_ignore'),
      topicsToInclude: core.getInput('topics_to_include'),
      excludePrivate: (core.getInput('exclude_private') === 'true'),
      excludeForked: (core.getInput('exclude_forked') === 'true'),
    });

    /*
     * 4. Management of files in selected repos starts one by one
     */
    for (const repo of reposList) {
      try {
        //start only if repo not on list of ignored
        if (!ignoredRepositories.includes(repo.name)) {        
          core.startGroup(`Started updating ${repo.name} repo using GitHub API`);
          const defaultBranch = repo.defaultBranch;

          /*
           * 4a. Checking what branches should this action operate on. 
           *     Should it be just default one or the ones provided by the user
           */
          const branchesToOperateOn = await getBranchesList(myOctokit, owner, repo.name, branches, defaultBranch); 
          if (!branchesToOperateOn[0].length) {
            core.info('Repo has no branches that the action could operate on');
            core.endGroup();
            continue;
          }

          /*
           * 4b. Per branch operation starts
           */
          for (const branch of branchesToOperateOn[0]) {
            const branchName = branch.name;
            core.info(`Processing branch: ${branchName}`);

            /*
             * 4ba. Creating new branch using GitHub API
             */
            const newBranchName = customBranchName || getBranchName(commitId, branchName);
            const wasBranchThereAlready = branchesToOperateOn[1].some(branch => branch.name === newBranchName);
            core.debug(`DEBUG: was branch ${newBranchName} there already in the repository? - ${wasBranchThereAlready}`);
            
            if (!wasBranchThereAlready) {
              await createBranchApi(myOctokit, owner, repo.name, branchName, newBranchName);
            } else {
              core.info(`Branch ${newBranchName} already exists, will update it`);
            }

            /*
             * 4bb. Files replication/update or deletion using GitHub API
             */         
            const hasChanges = await processFilesWithApi(
              myOctokit,
              owner,
              repo.name,
              filesToReplicate,
              filesToRemove,
              patternsToRemove ? [patternsToRemove] : null,
              newBranchName,
              commitMessage,
              committerUsername,
              committerEmail,
              destination
            );
                  
            //creating PR only if there are changes detected
            if (hasChanges) {
              /*
               * 4bc. Creating a PR using GitHub API
               */
              let pullRequestUrl;
              try {
                pullRequestUrl = await createPullRequestApi(
                  myOctokit,
                  owner,
                  repo.name,
                  commitMessage,
                  commitMessage, // Using commit message as body
                  newBranchName,
                  branchName
                );
              } catch (error) {
                if (wasBranchThereAlready)
                  core.info(`PR creation for ${repo.name} failed as the branch was there already. Instead only file updates were performed to existing ${newBranchName} branch`, error);
              }

              if (pullRequestUrl) {
                core.info(`Workflow finished with success and PR for ${repo.name} is created -> ${pullRequestUrl}`);
                
                // Auto-merge PR after 5 seconds using merge commit
                core.info(`Attempting to auto-merge PR after 5 seconds...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                try {
                  const prNumber = pullRequestUrl.split('/').pop();
                  await myOctokit.rest.pulls.merge({
                    owner,
                    repo: repo.name,
                    pull_number: prNumber,
                    merge_method: 'merge'
                  });
                  core.info(`Successfully auto-merged PR #${prNumber} for ${repo.name} using merge commit`);
                } catch (mergeError) {
                  core.warning(`Failed to auto-merge PR for ${repo.name}: ${mergeError.message}`);
                }
              } else if (!pullRequestUrl && wasBranchThereAlready) {
                core.info(`Workflow finished without PR creation for ${repo.name}. Instead file updates were performed to existing ${newBranchName} branch`);
              } else {
                core.info(`Unable to create a PR because of timeouts or other issues. Files were updated in branch ${newBranchName}`);
              }

              // Sleep between PR creations if configured
              if (sleepPrCreation > 0) {
                core.info(`Sleeping for ${sleepPrCreation} seconds before processing next repository...`);
                await new Promise(resolve => setTimeout(resolve, sleepPrCreation * 1000));
              }
            } else {
              core.info('Finished with success. No PR was created as no changes were detected');
            }
          }
          
          core.endGroup();
        }
      } catch (error) {
        core.endGroup();
        core.warning(`Failed replicating files for this repo: ${error}`);
        continue;
      }
    }
  } catch (error) {
    core.setFailed(`Action failed because of: ${error}`);
  }
}

run();
