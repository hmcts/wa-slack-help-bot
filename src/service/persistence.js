const JiraApi = require('jira-client');
const config = require('config')
const {createComment, mapFieldsToDescription, createResolveComment} = require("./jiraMessages");


const jiraCloudId = config.get('jira.cloud_id')
const issueTypeId = config.get('jira.issue_type_id')
const issueTypeName = config.get('jira.issue_type_name')

const jiraProject = config.get('jira.project')

const jiraStartTransitionId = config.get('jira.start_transition_id')
const jiraDoneTransitionId = config.get('jira.done_transition_id')
const extractProjectRegex = new RegExp(`(${jiraProject}-[\\d]+)`)

let systemAccountId;
let systemAccountIdPromise;

async function getSystemAccountId() {
    if (systemAccountId) return systemAccountId;

    if (!systemAccountIdPromise) {
        systemAccountIdPromise = jira.getCurrentUser()
            .then((user) => {
                if (!user?.accountId) {
                    throw new Error("Jira service account has no accountId");
                }

                systemAccountId = user.accountId;
                return systemAccountId;
            })
            .catch((err) => {
                systemAccountIdPromise = undefined;
                console.error("Unable to resolve Jira service account ID", err);
                throw err;
            });
    }

    return systemAccountIdPromise;
}

const jira = new JiraApi({
    protocol: 'https',
    host: 'api.atlassian.com',
    base: `/ex/jira/${jiraCloudId}`,
    username: config.get('jira.username'),
    password: config.get('jira.api_token'),
    apiVersion: '2',
    strictSSL: true
});

async function resolveHelpRequest(jiraId) {
    try {
        await jira.transitionIssue(jiraId, {
            transition: {
                id: jiraDoneTransitionId
            }
        })
    } catch (err) {
        console.log("Error resolving help request in jira", err)
    }
}

async function markAsDuplicate(jiraIdToUpdate, parentJiraId) {
    try {
        await jira.issueLink({
            type: {
                name: "Duplicate"
            },
            inwardIssue: {
                key: jiraIdToUpdate
            },
            outwardIssue: {
                key: parentJiraId
            },
        });

        await jira.transitionIssue(jiraIdToUpdate, {
            transition: {
                id: jiraDoneTransitionId
            }
        })
    } catch (err) {
        console.log("Error marking help request as duplicate in jira", err)
    }
}


async function startHelpRequest(jiraId) {
    try {
        await jira.transitionIssue(jiraId, {
            transition: {
                id: jiraStartTransitionId
            }
        })
    } catch (err) {
        console.log("Error starting help request in jira", err)
    }
}

async function getIssueDescription(issueId) {
    try {
        const issue = await jira.getIssue(issueId, 'description');
        return issue.fields.description;
    } catch(err) {
        if (err.statusCode === 404) {
            return undefined;
        } else {
            throw err
        }

    }
}

async function searchForUnassignedOpenIssues() {
    const jqlQuery = `project = ${jiraProject} AND type = "${issueTypeName}" AND status = Open and assignee is EMPTY AND labels not in ("Heritage") ORDER BY created ASC`;
    try {
        return await jira.searchJira(
            jqlQuery,
            {
                // TODO if we moved the slack link out to another field we wouldn't need to request the whole description
                // which would probably be better for performance
                fields: ['created', 'description', 'summary', 'updated']
            }
        )
    } catch (err) {
        console.log("Error searching for issues in jira", err)
        return {
            issues: []
        }
    }
}

async function assignHelpRequest(issueId, email) {
    const accountId = await convertEmail(email);

    try {
        await jira.updateAssigneeWithId(issueId, accountId);
    } catch (err) {
        console.log("Error assigning help request in Jira", err);
    }
}

/**
 * Extracts a jira ID
 *
 * expected format: 'View on Jira: <https://hmcts.atlassian.net/browse/SBOX-61|SBOX-61>'
 * @param blocks
 */
function extractJiraIdFromBlocks(blocks) {
    let viewOnJiraText
    if (blocks.length === 3) {
        viewOnJiraText = blocks[2].fields[0].text
    } else {
        viewOnJiraText = blocks[4].elements[0].text
    }

    project = extractProjectRegex.exec(viewOnJiraText);

    return (project) ? project[1] : 'undefined';
}

function extraJiraId(text) {
    return extractProjectRegex.exec(text)[1]
}

async function convertEmail(email) {
    if (!email) {
        return getSystemAccountId();
    }

    try {
        const users = await jira.searchUsers({
            query: email,
            maxResults: 1
        });

        if (!users?.[0]?.accountId) {
            console.log('Jira user not found; using service account as reporter');
            return getSystemAccountId();
        }
        return users[0].accountId;
    } catch (err) {
        console.log('Jira user lookup failed; using service account as reporter', err);
        return getSystemAccountId();
    }
}


async function createHelpRequestInJira(summary, project, user, labels) {
    console.log(`Creating help request in Jira for user: ${user}`)
    const issue = await jira.addNewIssue({
        fields: {
            summary: summary,
            issuetype: {
                id: issueTypeId
            },
            project: {
                id: project.id
            },
            labels: ['created-from-slack', ...labels],
            description: undefined,
            reporter: {
                accountId: user
            },
            customfield_10011: "RWA-3159",
            customfield_10383: { value: "M" }
        }
    });

    try {
        await jira.transitionIssue(issue.key, {
            transition: {
                id: "141" // Move to "To be Refined"
            }
        })
    } catch (err) {
        console.log("Unable to transition new issue", err)
    }

    return issue;
}

async function createHelpRequest({
                                     summary,
                                     userEmail,
                                     labels
                                 }) {
    const user = await convertEmail(userEmail)

    const project = await jira.getProject(jiraProject);

    const result = await createHelpRequestInJira(
        summary,
        project,
        user,
        labels)

    return result.key;
}

async function updateHelpRequestDescription(issueId, fields) {
    const jiraDescription = mapFieldsToDescription(fields);
    try {
        await jira.updateIssue(issueId, {
            update: {
                description: [{
                    set: jiraDescription
                }]
            }
        })
    } catch(err) {
        console.log("Error updating help request description in jira", err)
    }
}

async function addCommentToHelpRequest(externalSystemId, fields) {
    try {
        await jira.addComment(externalSystemId, createComment(fields))
    } catch (err) {
        console.log("Error creating comment in jira", err)
    }
}

async function addCommentToHelpRequestResolve(externalSystemId, { what, where, how} ) {
    try {
        await jira.addComment(externalSystemId, createResolveComment({what, where, how}))
    } catch (err) {
        console.log("Error creating comment in jira", err)
    }
}

async function addLabel(externalSystemId, { category} ) {
    try {
        await jira.updateIssue(externalSystemId, {
            update: {
                labels: [{
                    add: `resolution-${category.toLowerCase().replaceAll(' ', '-')}`
                }]
            }
        })
    } catch(err) {
        console.log("Error updating help request description in jira", err)
    }
}


module.exports.resolveHelpRequest = resolveHelpRequest
module.exports.startHelpRequest = startHelpRequest
module.exports.assignHelpRequest = assignHelpRequest
module.exports.createHelpRequest = createHelpRequest
module.exports.updateHelpRequestDescription = updateHelpRequestDescription
module.exports.addCommentToHelpRequest = addCommentToHelpRequest
module.exports.addCommentToHelpRequestResolve = addCommentToHelpRequestResolve
module.exports.addLabel = addLabel
module.exports.convertEmail = convertEmail
module.exports.extraJiraId = extraJiraId
module.exports.extractJiraIdFromBlocks = extractJiraIdFromBlocks
module.exports.searchForUnassignedOpenIssues = searchForUnassignedOpenIssues
module.exports.getIssueDescription = getIssueDescription
module.exports.markAsDuplicate = markAsDuplicate