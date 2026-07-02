/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// 3D model assets resolve to their bundled URL (vite assetsInclude "**/*.glb").
declare module "*.glb" {
  const src: string;
  export default src;
}
