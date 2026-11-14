#!/usr/bin/env node
// A stand-in for the `claude` CLI in tests: speaks the same stream-json output, connects back to the
// Caliper bridge over MCP like Claude Code does, and calls real Caliper tools. It never calls a model.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\n');
// Which of the parent session's variables reached this process.
if (process.env.FAKE_CLAUDE_ENV_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_ENV_LOG, JSON.stringify({ CLAUDECODE: process.env.CLAUDECODE ?? null, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null }) + '\n');
const prompt = opt('-p') || '';
const session = opt('--resume') || crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: session }) + '\n');
const url = JSON.parse(opt('--mcp-config')).mcpServers.caliper.url;

const client = new Client({ name: 'claude-code', version: '9.9.9' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
out({ type: 'system', subtype: 'init', model: 'fake', tools: ['mcp__caliper__get_state'], mcp_servers: [{ name: 'caliper', status: 'connected' }] });
const call = async (name, a = {}) => {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: crypto.randomUUID(), name: `mcp__caliper__${name}`, input: a }] } });
  return client.callTool({ name, arguments: a });
};
const say = (text) => {
  for (const piece of text.match(/.{1,12}/g)) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
};
// "parent-auth": sign-in only works with the inherited session variables (setups like that exist).
if (/parent-auth/.test(prompt) && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  out({ type: 'system', subtype: 'init', model: 'fake', tools: [], mcp_servers: [{ name: 'caliper', status: 'connected' }] });
  out({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] } });
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
  process.exit(1);
}
if (/fail/.test(prompt)) {
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
  process.exit(1);
}
if (/slow/.test(prompt)) await new Promise((r) => setTimeout(r, 30000));
await call('get_state', { include: ['build'] });
if (/box/.test(prompt)) {
  await call('set_model', { name: 'Chat box', params: [{ name: 'size', value: '40' }], features: [{ id: 'box1', type: 'box', name: 'Block', w: 'size', d: 'size', h: 10 }] });
  say('I made a 40 mm box. Change size to resize it.');
} else if (/taller/.test(prompt)) {
  await call('edit_model', { patch: [{ id: 'box1', set: { h: 25 } }] });
  say('It is 25 mm tall now.');
} else say('Nothing to change.');
out({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0, num_turns: 2 });
await client.close();
