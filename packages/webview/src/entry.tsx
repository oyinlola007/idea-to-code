import './zodConfig.js';
import '@vscode/codicons/dist/codicon.css';
import '@xyflow/react/dist/base.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
