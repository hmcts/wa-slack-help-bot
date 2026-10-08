jest.mock('@hmcts/properties-volume', () => ({addTo: config => config}));
jest.mock('config', () => ({get: key => ({
    'slack.report_channel_id': 'C_SUPPORT', 'slack.report_channel': 'support',
    'slack.bot_token': 'test-token', 'slack.app_token': 'test-app-token'
})[key]}));
jest.mock('./src/setupSecrets', () => ({setup: jest.fn()}));
jest.mock('./src/modules/appInsights', () => ({enableAppInsights: jest.fn()}));
jest.mock('http', () => ({createServer: jest.fn(() => ({listen: jest.fn()}))}));
jest.mock('@slack/bolt', () => ({
    App: jest.fn(() => ({
        start: jest.fn().mockResolvedValue(undefined), action: jest.fn(),
        event: jest.fn(), step: jest.fn(), shortcut: jest.fn(), view: jest.fn()
    })),
    WorkflowStep: jest.fn()
}));
jest.mock('./src/service/persistence', () => ({
    assignHelpRequest: jest.fn(),
    extractJiraIdFromBlocks: jest.fn(() => 'SBOX-61')
}));
const {App} = require('@slack/bolt');
const {assignHelpRequest} = require('./src/service/persistence');
require('./app');
const app = App.mock.results[0].value;
const handlers = new Map(app.action.mock.calls);
let client, body, ack;
beforeEach(() => {
    assignHelpRequest.mockReset().mockResolvedValue(undefined);
    client = {
        users: {profile: {get: jest.fn().mockImplementation(async ({user}) => ({profile: {
            email: user === 'U_SELECTED' ? 'selected@example.com' : 'actor@example.com'
        }}))}},
        chat: {postMessage: jest.fn(), update: jest.fn()}
    };
    body = {user: {id: 'U_ACTOR'}, channel: {id: 'C_SUPPORT'}, message: {
        ts: '100.001', text: 'New support request raised',
        blocks: [{}, {}, {}, {}, {}, {}, {type: 'actions', block_id: 'actions', elements: [
            {type: 'users_select', action_id: 'assign_help_request_to_user', placeholder: {type: 'plain_text', text: 'Unassigned'}},
            {type: 'button', action_id: 'assign_help_request_to_me'},
            {type: 'button', action_id: 'start_help_request'}
        ]}]
    }};
    ack = jest.fn();
});

it.each([undefined, 'U_PREVIOUS'])('persists dropdown selection over previous value %s', async previous => {
    if (previous) body.message.blocks[6].elements[0].initial_user = previous;
    const originalBlocks = JSON.parse(JSON.stringify(body.message.blocks));
    await handlers.get('assign_help_request_to_user')({body, action: {selected_user: 'U_SELECTED'}, ack, client});
    expect(ack).toHaveBeenCalledTimes(1);
    expect(client.users.profile.get).toHaveBeenCalledWith({user: 'U_SELECTED'});
    expect(assignHelpRequest).toHaveBeenCalledWith('SBOX-61', 'selected@example.com');
    originalBlocks[6].elements[0].initial_user = 'U_SELECTED';
    expect(client.chat.update).toHaveBeenCalledWith({
        channel: 'C_SUPPORT', ts: '100.001', text: 'New support request raised', blocks: originalBlocks
    });
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: "Hi, <@U_SELECTED>, you've just been assigned to this help request by <@U_ACTOR>"
    }));
});

it('finds the dropdown even if the action block position changes', async () => {
    body.message.blocks.unshift({type: 'section', text: {type: 'mrkdwn', text: 'Additional information'}});
    await handlers.get('assign_help_request_to_user')({body, action: {selected_user: 'U_SELECTED'}, ack, client});
    const savedBlocks = client.chat.update.mock.calls[0][0].blocks;
    expect(savedBlocks[7].elements[0].initial_user).toBe('U_SELECTED');
    expect(savedBlocks[0]).toEqual(body.message.blocks[0]);
});

it('keeps Take it persisting the actor', async () => {
    await handlers.get('assign_help_request_to_me')({body, ack, client});
    expect(assignHelpRequest).toHaveBeenCalledWith('SBOX-61', 'actor@example.com');
    expect(client.chat.update).toHaveBeenCalledWith(expect.objectContaining({blocks: body.message.blocks}));
    expect(body.message.blocks[6].elements[0].initial_user).toBe('U_ACTOR');
});

it('does not update the dropdown when assignment rejects', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
        assignHelpRequest.mockRejectedValue(new Error('Assignment failed'));
        await handlers.get('assign_help_request_to_user')({body, action: {selected_user: 'U_SELECTED'}, ack, client});
        expect(client.chat.update).not.toHaveBeenCalled();
        expect(client.chat.postMessage).not.toHaveBeenCalled();
        expect(body.message.blocks[6].elements[0].initial_user).toBeUndefined();
    } finally {
        errorLog.mockRestore();
    }
});
