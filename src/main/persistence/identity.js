'use strict';

// Identifiers that locate data created by Project Dock M00. They are part of the on-disk
// contract: changing any of them makes the app lose the ChatGPT login, the saved preferences or
// the generated ZIPs. The product is now called ContextDeck, but these stay as they are until a
// documented, idempotent migration exists (see docs/architecture.md, "Persistent identifiers").
module.exports = Object.freeze({
  // Electron's internal app name; it names the userData folder (%APPDATA%\Project Dock M00).
  USER_DATA_DIRNAME: 'Project Dock M00',
  // Chromium partition holding the ChatGPT cookies/storage (userData\Partitions\project-dock-m00-chat).
  CHAT_PARTITION: 'persist:project-dock-m00-chat',
  UI_STATE_FILE: 'ui-state.json',
  // Chat <-> workspace bindings (M01-I3A): a file of its own next to ui-state.json, see docs/decisions/0002-chat-bindings.md.
  CHAT_BINDINGS_FILE: 'chat-bindings.json',
  // Workspace <-> ChatGPT Project links (M01-I3B-3, experimental): own file, only created when CONTEXTDECK_PROJECTS=1 links one.
  PROJECT_BINDINGS_FILE: 'project-bindings.json',
  ARTIFACTS_DIRNAME: 'artifacts',
  CHAT_HOME: 'https://chatgpt.com/'
});
