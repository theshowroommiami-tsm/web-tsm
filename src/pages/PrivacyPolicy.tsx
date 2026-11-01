
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import FloatingCallButton from "@/components/FloatingCallButton";
import SEOHead from "@/components/SEOHead";
import { pageSEO } from "@/utils/seo";
import { BUSINESS_PHONE_DISPLAY, BUSINESS_PHONE_HREF } from "@/config/business";

// Texto legal en revisión (anl-05 v1.1, §2.1, 2.2, 2.5 y 2.7): pendiente de la revisión del abogado [SC] y de la
// aprobación de Liza y de Hikashi. No se publica antes de /custom-builds ni sin esa aprobación (anl-05 §1 y §5 (m)).
// La Sección 5 (SMS) forma parte del registro de la campaña 10DLC y no se modifica (anl-05 §3).
const PrivacyPolicy = () => {
  return (
    <div className="min-h-screen bg-black text-white">
      <SEOHead seoData={pageSEO.privacyPolicy} />
      <Navigation />

      {/* Hero Section */}
      <section className="relative py-24 px-4 sm:px-6 lg:px-8 bg-gradient-to-b from-black via-black/95 to-black">
        <div className="absolute inset-0 bg-grid-white/[0.02] bg-grid-16" />
        <div className="max-w-4xl mx-auto text-center relative z-10">
          <h1 className="text-4xl md:text-6xl font-orbitron font-bold mb-6">
            <span className="neon-text">Privacy Policy</span>
          </h1>
          <p className="text-xl text-gray-300 font-rajdhani">
            Your privacy matters to us. Learn how we protect and use your information.
          </p>
        </div>
      </section>

      {/* Content Section */}
      <section className="py-16 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto">
          <div className="bg-black/50 backdrop-blur-sm border border-neon-purple/30 rounded-lg p-8 neon-border">
            <p className="text-sm text-neon-cyan mb-8 font-medium">
              Effective Date: October 26, 2026 · Last Updated: November 1, 2026
            </p>

            <div className="space-y-8 text-gray-300 leading-relaxed">
              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  1. Introduction
                </h2>
                <p className="mb-4">
                  The Showroom Miami ("Company," "we," "our," or "us") provides luxury and exotic vehicle services in South Florida, including collision repair and insurance coordination, towing, wrap/PPF/tint installation, exotic vehicle rentals, custom builds, and sales and financing referrals. This Privacy Policy explains how we collect, use, disclose, and protect personal information when you visit our website, contact us, or use any of our services.
                </p>
                <p>
                  By using our website or services, you acknowledge that you have read and understood this Privacy Policy. If you do not agree with our practices, please do not use our website or services.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  2. Information We Collect
                </h2>
                <p className="mb-3">Depending on which service you use, we may collect:</p>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  <li><strong className="text-white">Contact and identity information:</strong> name, phone number, email address, mailing address.</li>
                  <li><strong className="text-white">Vehicle and service information:</strong> vehicle make/model/VIN, damage photos, repair estimates, custom build specifications, wrap/tint job details, rental agreements, and vehicle condition checklists (photo/video documentation at pickup and return).</li>
                  <li><strong className="text-white">Insurance information:</strong> insurance carrier, policy number, claim number, and adjuster contact details, submitted in connection with collision repair services.</li>
                  <li><strong className="text-white">Financial and financing information:</strong> information submitted through financing or credit applications, which may be shared with third-party lenders, dealerships, or financial institutions for the purpose of evaluating financing options. We do not store full financial account numbers on our own systems; these are submitted directly to our lending and dealer partners where applicable.</li>
                  <li><strong className="text-white">Driver's license and identification:</strong> required for towing dispatch verification, rental agreements, and certain financing applications.</li>
                  <li><strong className="text-white">Communications:</strong> records of calls, texts, emails, and form submissions, including call recordings where applicable (see Section 6).</li>
                  <li><strong className="text-white">Technical information:</strong> IP address, browser type, device information, and cookies collected through our website and analytics tools.</li>
                </ul>
                <p className="mt-4">
                  <strong className="text-white">Custom Builds estimate requests.</strong> If you submit the Request a Custom Build Estimate form, we collect your name, phone number, and email address; your vehicle's make, model, and year; your city or ZIP code; the service you are interested in and a description of your project; optionally, your approximate budget and timeline; and up to 3 photos that you choose to attach. We also record where your visit came from: campaign (UTM) parameters, the type and value of the Google click identifier (gclid, gbraid, or wbraid), the page you landed on, and the website that referred you. We use this information to respond to your request and to follow up with you about it, and our team is notified of each request by email. Photos can show license plates, addresses, or people; please do not upload documents or other people's personal information. For where this information is stored, who can access it, and how long we keep it, see Sections 4, 10, and 12.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  3. How We Use Your Information
                </h2>
                <p className="mb-3">We use personal information to:</p>
                <ul className="list-disc list-inside space-y-2 ml-4 mb-4">
                  <li>Provide, schedule, and manage the service you requested (collision repair, towing, wrap/PPF/tint, rentals, custom builds, or sales/finance referrals);</li>
                  <li>Communicate with you about bookings, estimates, claim status, and service updates;</li>
                  <li>Coordinate with insurance carriers on collision repair claims you have authorized us to handle;</li>
                  <li>Submit financing applications to lending or dealer partners on your behalf, where you have requested this service;</li>
                  <li>Process payments;</li>
                  <li>Verify identity and eligibility for rentals and financed transactions;</li>
                  <li>Maintain service records, condition documentation, and warranty history;</li>
                  <li>Comply with legal, insurance, and regulatory obligations;</li>
                  <li>Improve our website and services through aggregated analytics.</li>
                </ul>
                <p>
                  We do not use your information for any purpose beyond what is described in this Policy without your consent.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  4. How We Share Your Information
                </h2>
                <p className="mb-3">We do not sell your personal information. We may share information with:</p>
                <ul className="list-disc list-inside space-y-2 ml-4 mb-4">
                  <li>Insurance carriers and adjusters, for claims you have authorized us to submit or coordinate;</li>
                  <li>Lenders, banks, and dealership partners, for financing applications you have submitted;</li>
                  <li>Service and repair subcontractors (e.g., independent wrap/PPF installers, towing operators, or rental partners), limited to the information needed to perform the specific service;</li>
                  <li>Payment processors, to complete transactions;</li>
                  <li>Google (Google Analytics, Google Ads, Google Tag Manager, and Google Workspace), for website analytics, advertising, and measuring calls from our ads (see Section 12), and, through Google Workspace, for storing the requests you send through our Custom Builds form (Google acts as our service provider for that storage);</li>
                  <li>RingCentral, our telephony provider, for phone service and call recording (see Section 6);</li>
                  <li>JotForm, for our repair authorization form;</li>
                  <li>Netlify, for hosting our website and processing our Custom Builds form;</li>
                  <li>Cloudflare, for the security check (Turnstile) on our Custom Builds form and for the private storage of the photos you attach to it;</li>
                  <li>Legal or regulatory authorities, where required by law, subpoena, or court order;</li>
                  <li>Professional advisors (accountants, attorneys), where necessary for business operations.</li>
                </ul>
                <p className="mb-4">
                  When you complete our repair authorization form on JotForm, a submission ID is passed to our confirmation page and removed from the page address before any analytics or advertising tag runs. The content of the form is not sent to Google.
                </p>
                <p className="mb-4">
                  When you submit our Custom Builds estimate form, the request is processed by Netlify and saved in a Google Workspace spreadsheet that belongs to The Showroom Miami. The photos you attach are stored in private Cloudflare storage. Cloudflare Turnstile checks that the submission is not automated and may receive technical data from your browser. Only authorized personnel of The Showroom Miami can access your request and photos.
                </p>
                <p>
                  Any third party receiving your information is contractually or legally obligated to use it only for the purpose for which it was shared, to the extent required by applicable law.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  5. Text Message (SMS) Communications
                </h2>
                <p className="mb-3">
                  By providing your mobile number and opting in through our website, booking forms, or in-person intake, you consent to receive service-related and, where separately opted in, marketing text messages from The Showroom Miami. Message and data rates may apply. Message frequency varies.
                </p>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  <li>Mobile opt-in information and phone numbers collected for SMS purposes are not shared with third parties or affiliates for their own marketing purposes.</li>
                  <li>You may opt out of text messages at any time by replying STOP. You may reply HELP for assistance.</li>
                  <li>Consent to receive texts is not a condition of purchasing any service.</li>
                </ul>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  6. Call Recording
                </h2>
                <p className="mb-4">
                  Some inbound and outbound calls with our team may be recorded or monitored for quality assurance, training, dispute resolution, and service documentation purposes. We provide notice at the start of inbound and outbound calls that the call may be recorded. Florida law requires the consent of all parties to a call recording. By proceeding with a call after being notified (via this Policy, a recorded greeting, or verbal disclosure), you consent to such recording. Calls are recorded by default for security and service documentation purposes. If you do not wish to be recorded, please contact us by email at the address listed in Section 13 (Contact Us) instead of calling.
                </p>
                <p>
                  Our telephony provider is RingCentral. Call recordings are retained on RingCentral's servers for 90 days, and call logs are retained for up to 12 months (see Section 10). Access to call recordings is limited to authorized personnel of The Showroom Miami. We do not transcribe call recordings or analyze them with artificial intelligence (AI).
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  7. Financing Applications and Credit Information
                </h2>
                <p className="mb-3">If you submit a financing or credit application through us for referral to a lender or dealership partner:</p>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  <li>Your application data is forwarded to the relevant third-party lender(s) or dealer(s) you have authorized;</li>
                  <li>Those third parties, not The Showroom Miami, make credit decisions and are responsible for any adverse action notices required under the Fair Credit Reporting Act (FCRA) or applicable law;</li>
                  <li>We retain a copy of the submitted application for record-keeping and commission/referral tracking, subject to the retention period described in Section 10.</li>
                </ul>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  8. Data Security
                </h2>
                <p className="mb-4">
                  We use commercially reasonable safeguards, including SSL encryption and restricted internal access, to protect personal information. However, no method of electronic storage or transmission is completely secure, and we cannot guarantee absolute security.
                </p>
                <p>
                  In the event of a data breach affecting personal information as defined under Florida law, we will provide notice to affected individuals and, where required, to the Florida Department of Legal Affairs, in accordance with Fla. Stat. § 501.171 and other applicable law.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  9. Your Rights
                </h2>
                <p className="mb-3">Depending on your state of residence, you may have rights to:</p>
                <ul className="list-disc list-inside space-y-2 ml-4 mb-4">
                  <li>Request access to the personal information we hold about you;</li>
                  <li>Request correction of inaccurate information;</li>
                  <li>Request deletion of your personal information, subject to legal, contractual, or operational retention requirements (e.g., open insurance claims, active rentals, or financing records);</li>
                  <li>Opt out of marketing communications (see Section 5 for SMS opt-out).</li>
                </ul>
                <p>
                  To exercise any of these rights, contact us using the information in Section 13. We will respond within the timeframe required by applicable law, and may need to verify your identity before processing a request.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  10. Data Retention
                </h2>
                <p className="mb-3">
                  We retain personal information for as long as necessary to complete the service requested, satisfy insurance and warranty obligations, comply with legal and tax record-keeping requirements, and resolve disputes. As a general guideline:
                </p>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  <li>Collision repair and insurance records: retained for a minimum of 5 years from the closure of the claim or completion of the repair, whichever is later;</li>
                  <li>Rental agreements and vehicle condition documentation: retained for the duration of the rental plus 3 years;</li>
                  <li>Call recordings: retained on the servers of our telephony provider, RingCentral, for 90 days;</li>
                  <li>Call logs: retained for up to 12 months;</li>
                  <li>Custom Builds photos: retained for 12 months;</li>
                  <li>Custom Builds requests that do not become a service: retained for 24 months;</li>
                  <li>Financing applications: retained per lender/dealer partner requirements and our internal record-keeping needs.</li>
                </ul>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  11. Children's Privacy
                </h2>
                <p>
                  Our services are directed to individuals 18 years of age or older. We do not knowingly collect personal information from anyone under 18. If we learn that we have inadvertently collected such information, we will delete it promptly.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  12. Cookies and Tracking Technologies
                </h2>
                <p className="mb-4">
                  We use cookies and similar technologies to operate our website, remember preferences, and analyze site traffic through website analytics and advertising cookies. You can disable cookies through your browser settings, though some site features may not function properly as a result.
                </p>
                <p className="mb-4">
                  <strong className="text-white">Google Analytics.</strong> We use Google Analytics 4, through Google Tag Manager, to understand how visitors use our website. It measures page views; clicks on our call buttons and on the Request a Custom Build Estimate button, including where on the site the button was clicked; that a repair authorization was completed or that a Custom Builds request was submitted (the fact, not its content); and device, browser, and approximate location. Google Analytics uses the _ga and _ga_* cookies. Google Signals is turned off. Google Analytics and Google Ads do not receive what you type into our forms or the photos you attach; requests sent through our Custom Builds form are saved in Google Workspace, as described in Section 4. To learn how Google uses this data, see{" "}
                  <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener noreferrer" className="text-neon-pink hover:text-neon-cyan transition-colors">
                    How Google uses information from sites or apps that use our services
                  </a>
                  . To opt out of Google Analytics, you can use the{" "}
                  <a href="https://tools.google.com/dlpage/gaoptout" target="_blank" rel="noopener noreferrer" className="text-neon-pink hover:text-neon-cyan transition-colors">
                    Google Analytics Opt-out Browser Add-on
                  </a>
                  .
                </p>
                <p className="mb-4">
                  <strong className="text-white">Google Ads.</strong> We use Google Ads conversion measurement to understand which of our ads lead to actions on our website. It uses the gclid (a click identifier added to the page address when you arrive from one of our ads) and the _gcl_au cookie, set through the Conversion Linker in Google Tag Manager. A Custom Builds request or a signed repair authorization is reported to Google Ads as a fact, together with a random internal identifier (transaction ID) that is not personal data. We may also use remarketing and personalized advertising, which means Google may show you ads for our services on other websites and apps based on your visits to our website. To opt out of personalized advertising, visit{" "}
                  <a href="https://myadcenter.google.com" target="_blank" rel="noopener noreferrer" className="text-neon-pink hover:text-neon-cyan transition-colors">
                    My Ad Center
                  </a>
                  ,{" "}
                  <a href="https://optout.aboutads.info" target="_blank" rel="noopener noreferrer" className="text-neon-pink hover:text-neon-cyan transition-colors">
                    optout.aboutads.info
                  </a>
                  , or{" "}
                  <a href="https://optout.networkadvertising.org" target="_blank" rel="noopener noreferrer" className="text-neon-pink hover:text-neon-cyan transition-colors">
                    optout.networkadvertising.org
                  </a>
                  .
                </p>
                <p>
                  <strong className="text-white">Calls from our ads.</strong> When you call us from one of our Google ads, the call goes through a Google forwarding number that forwards it to our official phone number. Google receives the caller's area code, the time and duration of the call, and whether the call connected, so that we can count the calls that come from our ads.
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  13. Contact Us
                </h2>
                <p className="mb-3">If you have questions about this Privacy Policy or wish to exercise your rights, contact us at:</p>
                <p>
                  Email:{" "}
                  <a href="mailto:info@showroommiami.com" className="text-neon-pink hover:text-neon-cyan transition-colors">
                    info@showroommiami.com
                  </a>
                </p>
                <p>
                  Phone:{" "}
                  <a href={BUSINESS_PHONE_HREF} data-call-location="page_body" className="text-neon-pink hover:text-neon-cyan transition-colors">
                    {BUSINESS_PHONE_DISPLAY}
                  </a>
                </p>
              </div>

              <div>
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  14. Governing Law
                </h2>
                <p>
                  This Privacy Policy is governed by the laws of the State of Florida, without regard to conflict-of-law principles.
                </p>
              </div>

              <div className="pt-8 border-t border-neon-purple/30">
                <h2 className="text-2xl font-orbitron font-bold text-white mb-4 neon-text">
                  15. Changes to This Policy
                </h2>
                <p>
                  We may update this Privacy Policy from time to time. Material changes will be posted on this page with a revised "Last Updated" date. Continued use of our website or services after changes take effect constitutes acceptance of the updated Policy.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />
      <FloatingCallButton />
    </div>
  );
};

export default PrivacyPolicy;
