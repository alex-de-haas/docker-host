import type { DemoAppRoleSource } from "./app-roles";

export function roleSourceLabel(source: DemoAppRoleSource) {
  switch (source) {
    case "stored":
      return "App store";
    case "host-admin-bootstrap":
      return "Host admin bootstrap";
    case "host-assignment":
      return "Host assignment default";
    case "host-authenticated":
      return "Host login default";
    case "anonymous":
      return "Anonymous request";
  }
}
