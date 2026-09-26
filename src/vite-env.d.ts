/// <reference types="vite/client" />

// Side-effect CSS imports (import './styles/x.css') carry no types; declare them
// so tsc resolves the modules.
declare module '*.css';
