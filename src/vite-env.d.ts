/// <reference types="vite/client" />

/** 由 vite.config.ts 的 define 注入，来源是 package.json 的 version */
declare const __APP_VERSION__: string;

/** 由 vite.config.ts 的 define 注入，来源是 CI 的 run_number（本地为 "local"） */
declare const __BUILD_NO__: string;