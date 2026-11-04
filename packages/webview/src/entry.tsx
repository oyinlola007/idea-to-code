import './zodConfig.js';
import '@vscode/codicons/dist/codicon.css';
import '@xyflow/react/dist/base.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ChatApp } from './chat/ChatApp.js';

// One bundle draws both pages; the host says which in the HTML.
const root = document.getElementById('root');
if (root) createRoot(root).render(document.body.dataset.view === 'chat' ? <ChatApp /> : <App />);
