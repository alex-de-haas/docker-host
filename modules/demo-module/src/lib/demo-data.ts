export interface DemoPerson {
  id: string;
  name: string;
  role: string;
  status: "active" | "invited" | "disabled";
}

const fallbackPeople: DemoPerson[] = [
  {
    id: "ada",
    name: "Ada Lovelace",
    role: "Module admin",
    status: "active",
  },
  {
    id: "grace",
    name: "Grace Hopper",
    role: "Runtime tester",
    status: "active",
  },
  {
    id: "katherine",
    name: "Katherine Johnson",
    role: "Release reviewer",
    status: "invited",
  },
];

export function getDemoPeople(): DemoPerson[] {
  const rawPeople = process.env.DEMO_PEOPLE_JSON;
  if (!rawPeople) {
    return fallbackPeople;
  }

  try {
    const parsed = JSON.parse(rawPeople) as unknown;
    if (!Array.isArray(parsed)) {
      return fallbackPeople;
    }

    const people = parsed
      .map(normalizePerson)
      .filter((person): person is DemoPerson => person !== null);

    return people.length > 0 ? people : fallbackPeople;
  } catch {
    return fallbackPeople;
  }
}

function normalizePerson(value: unknown): DemoPerson | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const id = readNonEmptyString(candidate.id);
  const name = readNonEmptyString(candidate.name);
  const role = readNonEmptyString(candidate.role);
  const status = readStatus(candidate.status);

  if (!id || !name || !role || !status) {
    return null;
  }

  return { id, name, role, status };
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStatus(value: unknown): DemoPerson["status"] | null {
  return value === "active" || value === "invited" || value === "disabled" ? value : null;
}
