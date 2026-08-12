import { validatePublicCandidateTree } from "./public-candidate-policy.mjs";

export function validateReleaseStaging(tree) {
  return validatePublicCandidateTree(tree, { allowBuildOutput: true });
}
