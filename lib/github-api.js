const core = require('@actions/core');
const fs = require('fs');
const path = require('path');

module.exports = { 
  createBranchApi,
  updateFileApi,
  createFileApi,
  deleteFileApi,
  createPullRequestApi,
  getFileContent,
  getBranchSha,
  processFilesWithApi
};

async function getBranchSha(octokit, owner, repo, branchName) {
  try {
    const { data } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branchName}`
    });
    return data.object.sha;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function createBranchApi(octokit, owner, repo, baseBranch, newBranchName) {
  core.info(`Creating branch ${newBranchName} from ${baseBranch}`);
  
  const baseSha = await getBranchSha(octokit, owner, repo, baseBranch);
  if (!baseSha) {
    throw new Error(`Base branch ${baseBranch} not found`);
  }

  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${newBranchName}`,
      sha: baseSha
    });
    core.info(`Successfully created branch ${newBranchName}`);
    return true;
  } catch (error) {
    if (error.status === 422 && error.message.includes('already exists')) {
      core.info(`Branch ${newBranchName} already exists`);
      return false;
    }
    throw error;
  }
}

async function getFileContent(octokit, owner, repo, filePath, branchName) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branchName
    });
    
    if (data.type === 'file') {
      return {
        content: Buffer.from(data.content, 'base64').toString('utf8'),
        sha: data.sha
      };
    }
    return null;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function createFileApi(octokit, owner, repo, filePath, content, commitMessage, branchName, committerUsername, committerEmail) {
  core.info(`Creating file ${filePath} in ${repo}`);
  
  const base64Content = Buffer.from(content).toString('base64');
  
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: commitMessage,
    content: base64Content,
    branch: branchName,
    committer: {
      name: committerUsername,
      email: committerEmail
    },
    author: {
      name: committerUsername,
      email: committerEmail
    }
  });
  
  core.info(`Successfully created file ${filePath}`);
}

async function updateFileApi(octokit, owner, repo, filePath, content, commitMessage, branchName, committerUsername, committerEmail, sha) {
  core.info(`Updating file ${filePath} in ${repo}`);
  
  const base64Content = Buffer.from(content).toString('base64');
  
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: commitMessage,
    content: base64Content,
    sha,
    branch: branchName,
    committer: {
      name: committerUsername,
      email: committerEmail
    },
    author: {
      name: committerUsername,
      email: committerEmail
    }
  });
  
  core.info(`Successfully updated file ${filePath}`);
}

async function deleteFileApi(octokit, owner, repo, filePath, commitMessage, branchName, committerUsername, committerEmail, sha) {
  core.info(`Deleting file ${filePath} in ${repo}`);
  
  await octokit.rest.repos.deleteFile({
    owner,
    repo,
    path: filePath,
    message: commitMessage,
    sha,
    branch: branchName,
    committer: {
      name: committerUsername,
      email: committerEmail
    },
    author: {
      name: committerUsername,
      email: committerEmail
    }
  });
  
  core.info(`Successfully deleted file ${filePath}`);
}

async function createPullRequestApi(octokit, owner, repo, title, body, headBranch, baseBranch) {
  core.info(`Creating pull request from ${headBranch} to ${baseBranch} in ${repo}`);
  
  try {
    const { data } = await octokit.rest.pulls.create({
      owner,
      repo,
      title,
      body: body || title,
      head: headBranch,
      base: baseBranch
    });
    
    core.info(`Successfully created pull request #${data.number}: ${data.html_url}`);
    return data.html_url;
  } catch (error) {
    if (error.status === 422) {
      const errorMessage = (error.response && error.response.data && error.response.data.errors && error.response.data.errors[0] && error.response.data.errors[0].message) || error.message;
      if (errorMessage.includes('pull request already exists')) {
        core.info(`Pull request already exists for branch ${headBranch}`);
        return null;
      }
    }
    throw error;
  }
}

async function processFilesWithApi(octokit, owner, repo, filesToReplicate, filesToRemove, patternsToRemove, branchName, commitMessage, committerUsername, committerEmail, destination) {
  let hasChanges = false;

  if (filesToReplicate && filesToReplicate.length > 0) {
    for (const sourcePath of filesToReplicate) {
      try {
        if (!sourcePath) {
          core.warning('Skipping undefined/null file path');
          continue;
        }
        let targetPath = destination ? path.join(destination, sourcePath) : sourcePath;
        targetPath = targetPath.replace(/\\/g, '/');
        
        const sourceContent = fs.readFileSync(sourcePath, 'utf8');
        
        const existingFile = await getFileContent(octokit, owner, repo, targetPath, branchName);
        
        if (existingFile) {
          if (existingFile.content !== sourceContent) {
            await updateFileApi(octokit, owner, repo, targetPath, sourceContent, commitMessage, branchName, committerUsername, committerEmail, existingFile.sha);
            hasChanges = true;
          }
        } else {
          await createFileApi(octokit, owner, repo, targetPath, sourceContent, commitMessage, branchName, committerUsername, committerEmail);
          hasChanges = true;
        }
      } catch (error) {
        core.warning(`Failed to process file ${sourcePath}: ${error.message}`);
      }
    }
  }

  if (filesToRemove && filesToRemove.length > 0) {
    for (const fileToRemove of filesToRemove) {
      try {
        const filePath = destination ? path.join(destination, fileToRemove) : fileToRemove;
        const targetPath = filePath.replace(/\\/g, '/');
        
        const existingFile = await getFileContent(octokit, owner, repo, targetPath, branchName);
        if (existingFile) {
          await deleteFileApi(octokit, owner, repo, targetPath, commitMessage, branchName, committerUsername, committerEmail, existingFile.sha);
          hasChanges = true;
        }
      } catch (error) {
        core.warning(`Failed to remove file ${fileToRemove}: ${error.message}`);
      }
    }
  }

  if (patternsToRemove && patternsToRemove.length > 0) {
    const micromatch = require('micromatch');
    
    try {
      const { data: repoContents } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: '',
        ref: branchName
      });
      
      const allFiles = await getAllFilesRecursive(octokit, owner, repo, repoContents, branchName);
      
      const filesToDelete = allFiles.filter(file => 
        micromatch.isMatch(file.path, patternsToRemove, { dot: true })
      );
      
      for (const file of filesToDelete) {
        try {
          await deleteFileApi(octokit, owner, repo, file.path, commitMessage, branchName, committerUsername, committerEmail, file.sha);
          hasChanges = true;
        } catch (error) {
          core.warning(`Failed to delete file matching pattern ${file.path}: ${error.message}`);
        }
      }
    } catch (error) {
      core.warning(`Failed to process file patterns for removal: ${error.message}`);
    }
  }

  return hasChanges;
}

async function getAllFilesRecursive(octokit, owner, repo, contents, branchName, basePath = '') {
  let allFiles = [];
  
  for (const item of contents) {
    if (item.type === 'file') {
      allFiles.push({
        path: basePath ? `${basePath}/${item.name}` : item.name,
        sha: item.sha
      });
    } else if (item.type === 'dir') {
      try {
        const { data: subContents } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: item.path,
          ref: branchName
        });
        
        const subFiles = await getAllFilesRecursive(
          octokit, 
          owner, 
          repo, 
          subContents, 
          branchName, 
          basePath ? `${basePath}/${item.name}` : item.name
        );
        allFiles = allFiles.concat(subFiles);
      } catch (error) {
        core.warning(`Failed to read directory ${item.path}: ${error.message}`);
      }
    }
  }
  
  return allFiles;
}