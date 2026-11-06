import { createContext, runInContext } from "node:vm";

/** Run the actual embedded dashboard script and controls without a browser. */
export function evaluateDashboard(page: string, url = "file:///report.html") {
  const elements: Record<string, any> = {};
  const get = (id: string) => elements[id] ??= {
    value: ({ group: "combo", bucket: "4week", "token-metric": "output" } as Record<string, string>)[id] ?? "",
    checked: id === "commits" || id === "markers", innerHTML: "", textContent: "",
    addEventListener(_event: string, handler: () => void) { this.change = handler; },
  };
  const ctx = createContext({ document: { getElementById: get }, location: new URL(url), URLSearchParams });
  runInContext(page.match(/<script>([\s\S]*)<\/script>/)![1]!, ctx);
  return { get, read: (expression: string) => runInContext(expression, ctx), change(id: string, value: string | boolean) {
    get(id)[typeof value === "boolean" ? "checked" : "value"] = value;
    get(id).change();
  } };
}
