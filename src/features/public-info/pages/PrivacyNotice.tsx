import { PublicInfoLayout } from "../PublicInfoLayout";
import { SupportContactBlock } from "../SupportContactBlock";

/**
 * Privacy notice — DRAFT scaffolding.
 *
 * Describes what the system actually does today (checked against the schema
 * and routes in this repository), in plain English, so a lawyer can turn it
 * into a real notice. It deliberately makes no promises the code does not keep
 * and cites no law, because that is the reviewer's job, not ours.
 *
 * Long-form version for the reviewer: src/docs/ops/privacy-data-handling-DRAFT.md
 */
export default function PrivacyNotice() {
  return (
    <PublicInfoLayout
      draft
      testId="privacy-notice-page"
      title="Privacy notice (draft)"
      lede="How this estate's GatePass system handles information about visitors, residents and guards. Draft for review — not yet approved."
    >
      <section>
        <h2>Who runs this system</h2>
        <p>
          GatePass is operated by the estate and its appointed security company (the
          &ldquo;operator&rdquo;). The operator is responsible for the information held in it.
          The operator&rsquo;s name and contact details will be filled in here after review.
        </p>
      </section>

      <section>
        <h2>What information is recorded, and why</h2>
        <ul>
          <li>
            <strong>Visitors:</strong> name, phone number, who you are visiting, vehicle
            plate (if given), the reason for the visit, and the time you were let in and
            out. This is recorded so the estate knows who is on the premises and can
            trace an entry later if something goes wrong.
          </li>
          <li>
            <strong>Residents:</strong> name, unit and phone number, so the gate can ask
            you to approve or deny a visitor, and so approved visitors can be linked to
            the right household.
          </li>
          <li>
            <strong>Guards and administrators:</strong> name, badge number, work email and
            role, plus a record of every action taken in the system (entries logged,
            overrides, exits, account changes). This is how the estate can hold staff
            accountable and reconstruct a shift.
          </li>
          <li>
            <strong>Technical records:</strong> the system keeps an audit trail of what
            happened and when, with a random reference number for each event. Security
            codes (one-time PINs, QR tokens) are stored in a scrambled form that cannot be
            turned back into the code.
          </li>
        </ul>
      </section>

      <section>
        <h2>What is not shown publicly</h2>
        <p>
          A visitor&rsquo;s pass page shows only what that visitor needs: their own pass,
          its status and the host&rsquo;s name. A resident&rsquo;s approval link shows only
          the request addressed to them. Neither page shows other visitors, other
          residents, guard details, or the estate&rsquo;s audit records. Those are
          available only to signed-in staff with the appropriate role.
        </p>
      </section>

      <section>
        <h2>Who can see it</h2>
        <ul>
          <li>Guards on duty see the visitors they are processing at the gate.</li>
          <li>
            Senior guards and administrators can review shift logs, who is currently on the
            premises, delivery records and the audit trail.
          </li>
          <li>Administrators can create and deactivate staff accounts.</li>
          <li>
            The operator&rsquo;s hosting provider stores the data on the operator&rsquo;s
            behalf.
          </li>
        </ul>
      </section>

      <section>
        <h2>How long it is kept</h2>
        <p>
          <strong>To be set by the operator after review.</strong> The system does not
          delete records automatically today; the operator must decide a retention period
          and have it applied. Audit records are kept as written and are not edited.
        </p>
      </section>

      <section>
        <h2>Your choices</h2>
        <p>
          If you believe information about you is wrong, or you want to ask what is held
          about you, contact the operator using the details below. The operator will set
          out, after review, how such requests are handled and within what time.
        </p>
      </section>

      <SupportContactBlock heading="How to contact the operator" />
    </PublicInfoLayout>
  );
}
