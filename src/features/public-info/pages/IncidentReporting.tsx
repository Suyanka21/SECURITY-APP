import { Link } from "react-router-dom";
import { PublicInfoLayout } from "../PublicInfoLayout";
import { SupportContactBlock } from "../SupportContactBlock";

/**
 * Incident reporting — operational page.
 *
 * Deliberately NOT a form: a public, unauthenticated form that accepts free
 * text about people and security events would itself be a new store of
 * personal data with no access control. Reports go to a human via the
 * configured contact; the internal handling steps live in
 * src/docs/ops/incident-response.md.
 */
export default function IncidentReporting() {
  return (
    <PublicInfoLayout
      draft={false}
      testId="incident-page"
      title="Report a problem"
      lede="How to report a security or privacy concern about this estate's GatePass system, and what happens next."
    >
      <section>
        <h2>Report straight away if</h2>
        <ul>
          <li>Someone was let in who should not have been, or your name was used for a visit you did not make.</li>
          <li>You received an approval request or pass that was not meant for you.</li>
          <li>A guard&rsquo;s device or login may be lost, stolen or shared.</li>
          <li>You believe personal information has been seen by someone who should not see it.</li>
          <li>A page showed you information about another person.</li>
        </ul>
      </section>

      <section>
        <h2>What to include</h2>
        <ul>
          <li>What happened, and when (date and approximate time).</li>
          <li>Which gate or estate, if there is more than one.</li>
          <li>
            The <em>support reference</em> if a page showed one (a code beginning{" "}
            <code>trace-</code>). It contains no personal data and helps the operator find
            the exact event.
          </li>
          <li>How to reach you for follow-up.</li>
        </ul>
        <p>
          Please do not include other people&rsquo;s ID numbers, photographs or documents
          unless the operator asks for them.
        </p>
      </section>

      <section>
        <h2>What happens next</h2>
        <p>
          The operator&rsquo;s supervisor on duty is expected to acknowledge the report,
          preserve the relevant records (which the system does not allow to be edited),
          and follow the estate&rsquo;s incident procedure. Where a report involves
          personal information, the operator&rsquo;s privacy process applies — see the{" "}
          <Link className="underline" to="/legal/privacy">
            privacy notice
          </Link>
          . Response times and any external notification duties are for the operator to
          confirm with its legal adviser before launch.
        </p>
      </section>

      <SupportContactBlock heading="Where to send the report" />
    </PublicInfoLayout>
  );
}
