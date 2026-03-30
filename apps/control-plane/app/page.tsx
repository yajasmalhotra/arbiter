import { listAuditEvents, listPolicies } from "../lib/store";

const pill = (label: string) => (
  <span
    style={{
      display: "inline-block",
      marginRight: 8,
      marginBottom: 6,
      padding: "2px 8px",
      border: "1px solid #374151",
      borderRadius: 999,
      fontSize: 12
    }}
  >
    {label}
  </span>
);

export default async function HomePage() {
  const [policies, auditEvents] = await Promise.all([listPolicies(), listAuditEvents()]);
  const byState = policies.reduce<Record<string, number>>((acc, policy) => {
    acc[policy.rolloutState] = (acc[policy.rolloutState] || 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <section style={{ border: "1px solid #1f2937", padding: 16, borderRadius: 12 }}>
        <h2 style={{ marginTop: 0 }}>Policy Summary</h2>
        <p style={{ opacity: 0.8 }}>Total policies: {policies.length}</p>
        <div>{Object.entries(byState).map(([state, count]) => pill(`${state}: ${count}`))}</div>
      </section>

      <section style={{ border: "1px solid #1f2937", padding: 16, borderRadius: 12 }}>
        <h2 style={{ marginTop: 0 }}>Latest Policies</h2>
        <ul>
          {policies.slice(0, 10).map((policy) => (
            <li key={policy.id}>
              <strong>{policy.name}</strong> - {policy.packageName} ({policy.rolloutState})
            </li>
          ))}
        </ul>
      </section>

      <section style={{ border: "1px solid #1f2937", padding: 16, borderRadius: 12 }}>
        <h2 style={{ marginTop: 0 }}>Recent Audit Events</h2>
        <ul>
          {auditEvents.slice(0, 10).map((event) => (
            <li key={event.id}>
              {event.at} - {event.action} ({event.actor})
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
