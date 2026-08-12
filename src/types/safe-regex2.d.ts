declare module "safe-regex2" {
  export default function safeRegex(pattern: string | RegExp, options?: { limit?: number }): boolean;
}
