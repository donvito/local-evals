import { isValidElement, type ReactNode } from "react";

const NON_TEXT_PROPS = new Set([
  "className",
  "id",
  "href",
  "role",
  "type",
  "tabIndex",
  "key",
  "kind",
  "icon",
  "tab",
]);

const valueText = (value: unknown): string => {
  if (value == null || typeof value === "boolean" || typeof value === "function") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(" ");
  if (isValidElement<Record<string, unknown>>(value)) return propsText(value.props);
  if (typeof value === "object") return propsText(value as Record<string, unknown>);
  return "";
};

const propsText = (props: Record<string, unknown>) =>
  Object.entries(props)
    .filter(
      ([name]) =>
        !NON_TEXT_PROPS.has(name) && !name.startsWith("aria-") && !name.startsWith("data-"),
    )
    .map(([, value]) => valueText(value))
    .join(" ");

export const helpText = (node: ReactNode): string => valueText(node);

const normalize = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");

export const matchesHelpQuery = (text: string, query: string) => {
  const terms = normalize(query).split(" ").filter(Boolean);
  const haystack = normalize(text);
  return terms.every((term) => haystack.includes(term));
};

export const anchorFromHash = (hash: string, route: string) => {
  const [base, anchor, ...rest] = hash.replace(/^#/, "").split("/");
  return base === route && !rest.length && anchor && /^[a-z0-9-]+$/.test(anchor)
    ? anchor
    : null;
};
