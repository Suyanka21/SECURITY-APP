import { readSupportContact } from "./supportContact";

/**
 * Renders the configured estate contact, or an honest "not configured yet"
 * notice. Never a placeholder address that looks real.
 */
export function SupportContactBlock({ heading }: { heading: string }) {
  const contact = readSupportContact();
  return (
    <section data-testid="support-contact">
      <h2>{heading}</h2>
      {contact.configured ? (
        <ul>
          {contact.email && (
            <li>
              Email: <a className="underline" href={`mailto:${contact.email}`}>{contact.email}</a>
            </li>
          )}
          {contact.phone && (
            <li>
              Phone: <a className="underline" href={`tel:${contact.phone}`}>{contact.phone}</a>
            </li>
          )}
        </ul>
      ) : (
        <p
          data-testid="support-contact-unconfigured"
          className="border border-dashed border-amber-600 bg-amber-50 p-3 text-amber-950"
        >
          The estate has not yet published a support contact in this system. Please speak
          to the guard at the gate or to your estate management office.
        </p>
      )}
    </section>
  );
}
