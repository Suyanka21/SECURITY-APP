import { Link } from "react-router-dom";
import { PublicInfoLayout } from "../PublicInfoLayout";
import { SupportContactBlock } from "../SupportContactBlock";

/** Support / contact — operational page (not legal text, so no draft banner). */
export default function Support() {
  return (
    <PublicInfoLayout
      draft={false}
      testId="support-page"
      title="Support"
      lede="Who to contact when something about your visit, your approval link or your account is not working."
    >
      <section>
        <h2>Visitors</h2>
        <ul>
          <li>
            <strong>Pass says expired, already used, locked or not found:</strong> ask the
            person you are visiting to send a new pass. Guards cannot unlock a pass at the
            gate.
          </li>
          <li>
            <strong>Pass page will not load:</strong> check your connection and try again.
            If it still fails, show the guard the message on your screen.
          </li>
        </ul>
      </section>

      <section>
        <h2>Residents</h2>
        <ul>
          <li>
            <strong>Approval link does not open or says it was already handled:</strong>{" "}
            call the gate directly. The guard can see the request&rsquo;s current state and
            can ask again if needed.
          </li>
          <li>
            <strong>You did not receive a request you expected:</strong> confirm the gate
            has your current phone number.
          </li>
        </ul>
      </section>

      <section>
        <h2>Guards and administrators</h2>
        <ul>
          <li>
            <strong>Cannot sign in:</strong> passwords are reset by an administrator; the
            gate console cannot reset them. Contact your supervisor.
          </li>
          <li>
            <strong>Working offline:</strong> the console keeps entries on the device and
            sends them when the connection returns. Do not clear the browser or sign out
            while entries are still pending.
          </li>
          <li>
            <strong>Anything that looks like a security problem</strong> — a lost device,
            a shared password, an entry you cannot explain — use{" "}
            <Link className="underline" to="/support/incident">
              Report a problem
            </Link>{" "}
            and tell your supervisor now, not at the end of the shift.
          </li>
        </ul>
      </section>

      <section>
        <h2>The &ldquo;support reference&rdquo;</h2>
        <p>
          When something fails, the page may show a <em>support reference</em> — a random
          code like <code>trace-…</code>. It contains no personal information. Quote it
          when you contact support; it lets the operator find the matching event in the
          system&rsquo;s records.
        </p>
      </section>

      <SupportContactBlock heading="Contact the estate support desk" />
    </PublicInfoLayout>
  );
}
