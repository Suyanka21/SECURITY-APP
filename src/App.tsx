import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OnboardingGate } from "./features/onboarding/OnboardingGate";
import { AuthProvider } from "./features/auth/AuthContext";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";
import ResidentApproval from "./pages/ResidentApproval.tsx";
import VisitorPass from "./pages/VisitorPass.tsx";
import PrivacyNotice from "./features/public-info/pages/PrivacyNotice";
import TermsOfUse from "./features/public-info/pages/TermsOfUse";
import Support from "./features/public-info/pages/Support";
import IncidentReporting from "./features/public-info/pages/IncidentReporting";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route
            path="/"
            element={
              <AuthProvider>
                <OnboardingGate>
                  <Index />
                </OnboardingGate>
              </AuthProvider>
            }
          />
          {/* Resident magic-link approval page (spec §10). */}
          <Route path="/approve/:id" element={<ResidentApproval />} />
          {/* Visitor-facing QR pass page (Feature 6 spec §7, §A6). */}
          <Route path="/pass/:token" element={<VisitorPass />} />
          {/* Role-neutral public info pages (Task 7.4). Legal pages are DRAFTS. */}
          <Route path="/legal/privacy" element={<PrivacyNotice />} />
          <Route path="/legal/terms" element={<TermsOfUse />} />
          <Route path="/support" element={<Support />} />
          <Route path="/support/incident" element={<IncidentReporting />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
