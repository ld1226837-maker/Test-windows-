import { CustomerDirectoryCard } from "./CustomerDirectoryCard";
import { LayoutSection, LayoutSections } from "./LayoutSection";
import { CustomerTeamsDirectory } from "./CustomerTeams";

/**
 * Top-level "Customers" tab (Android).
 *
 * Previously the customer directory lived inside Settings. This is a thin
 * wrapper: `CustomerDirectoryCard` still holds all the actual list/search/
 * add/merge logic, completely unchanged from when it lived in Settings — no
 * desktop two-pane treatment here, since right-click/two-pane concepts don't
 * apply to a phone-width window (matches the Windows-only scoping used for
 * every other productivity-pass item in this engagement). Wrapped in
 * `LayoutSections` (matching every other tab) so the one section still
 * participates in Settings → Layout & arrangement.
 */
export function CustomersTab() {
  return (
    <div className="space-y-6">
      <LayoutSections tabId="customers" className="space-y-6">
        <LayoutSection id="customers.directory">
          <CustomerDirectoryCard />
        </LayoutSection>
        <LayoutSection id="customers.teams">
          <CustomerTeamsDirectory />
        </LayoutSection>
      </LayoutSections>
    </div>
  );
}
