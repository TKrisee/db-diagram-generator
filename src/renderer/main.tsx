import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './query.css';
import './queryPlan.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);
