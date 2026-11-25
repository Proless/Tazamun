// Lets plain TypeScript (and type-aware ESLint) import .vue files. vue-tsc reads the real
// component types; keep the logic in .ts files so it's linted and unit-tested.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
