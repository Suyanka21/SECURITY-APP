import { PublicInfoLayout } from "../PublicInfoLayout";
import { SupportContactBlock } from "../SupportContactBlock";

/** Terms / acceptable use — DRAFT scaffolding for legal review. */
export default function TermsOfUse() {
  return (
    <PublicInfoLayout
      draft
      testId="terms-page"
      title="Terms of use and acceptable use (draft)"
      lede="Plain-English expectations for anyone using this estate's GatePass system. Draft for review — not yet approved."
    >
      <section>
        <h2>What GatePass is</h2>
        <p>
          GatePass is the estate&rsquo;s tool for recording who enters and leaves. It helps
          guards do their job; it does not replace their judgement, and it does not by
          itself decide who may enter. Final decisions at the gate rest with the estate
          and its security staff.
        </p>
      </section>

      <section>
        <h2>Visitors</h2>
        <ul>
          <li>Your pass or PIN is personal to your visit. Do not share or forward it.</li>
          <li>A pass can expire, be used once only, or be locked after repeated wrong PINs.</li>
          <li>Give accurate details. Guards may refuse entry if details do not match.</li>
        </ul>
      </section>

      <section>
        <h2>Residents</h2>
        <ul>
          <li>Approval links sent to you are for you alone. Do not forward them.</li>
          <li>
            Approving a visitor tells the gate you expect them; you remain responsible for
            your guests while they are on the premises, as set out in your estate rules.
          </li>
          <li>Tell the estate if your phone number changes so requests reach you.</li>
        </ul>
      </section>

      <section>
        <h2>Guards and administrators</h2>
        <ul>
          <li>Use only your own account. Never share a login or leave a signed-in device unattended.</li>
          <li>Record entries truthfully. Overrides must state a real reason and are reviewed.</li>
          <li>Sign out at the end of every shift.</li>
          <li>Report a lost or stolen device, or any suspected misuse, immediately.</li>
        </ul>
      </section>

      <section>
        <h2>Not allowed</h2>
        <ul>
          <li>Trying to access records you are not authorised to see.</li>
          <li>Guessing or brute-forcing PINs, tokens or links.</li>
          <li>Entering false information or altering records.</li>
        </ul>
        <p>
          The system limits repeated attempts and records staff actions. Misuse may be
          dealt with under the estate&rsquo;s rules and the security company&rsquo;s
          employment terms.
        </p>
      </section>

      <section>
        <h2>Availability and liability</h2>
        <p>
          <strong>To be drafted by the legal reviewer.</strong> This draft makes no
          statement about availability guarantees, limitation of liability, governing law
          or dispute resolution. Those must be written by a qualified professional for the
          operator&rsquo;s jurisdiction.
        </p>
      </section>

      <SupportContactBlock heading="Questions" />
    </PublicInfoLayout>
  );
}
