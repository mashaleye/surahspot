/**
 * Ambient declarations for non-code imports.
 *
 * Next generates these into .next/types during a build, so `tsc --noEmit`
 * fails on a clean checkout before anything has been built — which is exactly
 * the order CI runs things in. Declaring them here makes typecheck independent
 * of build artifacts.
 */
declare module "*.css";
declare module "*.svg" {
  const content: string;
  export default content;
}
