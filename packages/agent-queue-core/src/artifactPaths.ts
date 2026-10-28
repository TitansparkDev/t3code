export function artifactPathsOverlap(left: string, right: string): boolean {
  const prefix = (path: string) => {
    const wildcard = path.search(/[*?{}[\]]/);
    return wildcard < 0 ? path : path.slice(0, wildcard).replace(/[^/]*$/, "");
  };
  const a = prefix(left);
  const b = prefix(right);
  const nested = (parent: string, child: string) =>
    child === parent || child.startsWith(`${parent.replace(/\/+$/, "")}/`);
  return a === "" || b === "" || nested(a, b) || nested(b, a);
}
