// CI gate probe: intentionally introduces an explicit `any` in NEW code
// (NOT in the legacy no-explicit-any override list) to prove the lint gate
// still hard-fails. Removed in the immediately following commit.
export function ciGateProbe(value: any) {
  return value;
}
