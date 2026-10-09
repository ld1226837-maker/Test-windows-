import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Eye, Printer, RotateCcw, Wand2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";

import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_PRINT_SETTINGS,
  DENSITY_OPTIONS,
  LINE_SPACING_OPTIONS,
  PAPER_TYPES,
  PRINTER_PRESETS,
  isRollPaper,
  usePrintSettings,
  type DensityId,
  type LineSpacingId,
  type PaperId,
} from "@/lib/print";
import { UPI_APPS, type UpiAppId } from "@/lib/receipt-upi";
import {
  SAMPLE_DOCUMENT_OPTIONS,
  sampleDocument,
  type SampleDocumentKind,
} from "@/lib/document-samples";
import { isAndroid } from "@/lib/desktop";
import { previewReceipt, printReceipt } from "@/lib/receipt";
import {
  SettingsActions,
  SettingsField,
  SettingsGrid,
  SettingsGroup,
  SettingsSwitchRow,
} from "./SettingsField";

export function PrintSettingsCard({
  branding,
}: {
  /** Business-identity artwork (logo, banner, backgrounds), rendered as the
   * first part of group 1 so identity lives in one place. */
  branding?: ReactNode;
} = {}) {
  const [sampleKind, setSampleKind] = useState<SampleDocumentKind>("sales");
  const sample = sampleDocument(sampleKind);
  const { settings, save } = usePrintSettings();
  const set = <K extends keyof typeof settings>(
    k: K,
    v: (typeof settings)[K],
  ) => save({ ...settings, [k]: v });
  const rollPaper = isRollPaper(settings.paper);
  const [vpaOpen, setVpaOpen] = useState(false);
  const [payeeOpen, setPayeeOpen] = useState(false);
  const [numberDrafts, setNumberDrafts] = useState({
    customWidthMm: String(settings.customWidthMm),
    copies: String(settings.copies),
    cutFeedMm: String(settings.cutFeedMm),
    marginMm: String(settings.marginMm),
    a4ContentTopMm: String(settings.a4ContentTopMm),
  });

  // Keep edits as text until the field is complete. Saving on every keypress
  // made it impossible to clear "80" before typing a new width: the empty
  // intermediate value was immediately replaced with a fallback number.
  useEffect(() => {
    setNumberDrafts({
      customWidthMm: String(settings.customWidthMm),
      copies: String(settings.copies),
      cutFeedMm: String(settings.cutFeedMm),
      marginMm: String(settings.marginMm),
      a4ContentTopMm: String(settings.a4ContentTopMm),
    });
  }, [
    settings.customWidthMm,
    settings.copies,
    settings.cutFeedMm,
    settings.marginMm,
    settings.a4ContentTopMm,
  ]);

  const editNumber = (key: keyof typeof numberDrafts, value: string) =>
    setNumberDrafts((current) => ({ ...current, [key]: value }));

  const commitNumber = (
    key: keyof typeof numberDrafts,
    min: number,
    max: number,
    fallback: number,
    round = false,
  ) => {
    const parsed = Number(numberDrafts[key]);
    const value = Number.isFinite(parsed)
      ? Math.max(min, Math.min(max, parsed))
      : fallback;
    const committed = round ? Math.round(value) : value;
    set(key, committed as (typeof settings)[typeof key]);
  };

  const textSize = (
    <Select
      value={String(settings.fontScale)}
      onValueChange={(v) => set("fontScale", Number(v))}
    >
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="0.9">Small</SelectItem>
        <SelectItem value="1">Normal</SelectItem>
        <SelectItem value="1.15">Large</SelectItem>
        <SelectItem value="1.3">Extra large</SelectItem>
      </SelectContent>
    </Select>
  );

  return (
    <section className="space-y-3">
      <Card className="frost">
        <CardContent className="space-y-6 p-4 sm:p-5">
          <SettingsGroup
            title="1 · Business identity & artwork"
            hint="Name, logo and letterhead artwork, plus the address lines printed under them."
          >
            {branding}
            <SettingsGrid>
              <SettingsField
                label="Shop address on receipt"
                full
                reserveHint={false}
              >
                <Textarea
                  rows={2}
                  value={settings.shopAddress}
                  onChange={(e) => set("shopAddress", e.target.value)}
                  placeholder="Leave blank to skip printing the address"
                />
              </SettingsField>
              <SettingsField label="Shop phone on receipt">
                <Input
                  inputMode="tel"
                  value={settings.shopPhone}
                  onChange={(e) => set("shopPhone", e.target.value)}
                  placeholder="Leave blank to skip"
                />
              </SettingsField>
              <SettingsField label="Shop email on receipt">
                <Input
                  type="email"
                  value={settings.shopEmail}
                  onChange={(e) => set("shopEmail", e.target.value)}
                  placeholder="Leave blank to skip"
                />
              </SettingsField>
            </SettingsGrid>
          </SettingsGroup>

          <Separator />

          <SettingsGroup
            title="2 · Invoice layout"
            hint="How sales bills, booking bills and snack receipts look. Expense vouchers and investment statements always use the plain layout with the same header."
          >
            <div className="grid gap-2 lg:grid-cols-2">
              <SettingsSwitchRow
                label="Premium boxed & colored layout"
                hint="Two-tone letterhead style for A4/A5/80mm/58mm/50mm. Other paper sizes keep the plain layout."
                checked={settings.templateStyle === "premium"}
                onCheckedChange={(v) =>
                  set("templateStyle", v ? "premium" : "classic")
                }
              />
              {settings.templateStyle === "premium" &&
                settings.paper === "80mm" && (
                  <SettingsSwitchRow
                    label="Color on the 80mm premium layout"
                    hint="Off (default) keeps it ink-safe black & white for real thermal printers; on renders it in full color for a color printer or a screen/WhatsApp copy."
                    checked={settings.thermalColorMode === "color"}
                    onCheckedChange={(v) =>
                      set("thermalColorMode", v ? "color" : "bw")
                    }
                  />
                )}
            </div>
            <SettingsGrid>
              <SettingsField label="Text size">{textSize}</SettingsField>
              <SettingsField label="Line spacing">
                <Select
                  value={settings.lineSpacing}
                  onValueChange={(v) => set("lineSpacing", v as LineSpacingId)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LINE_SPACING_OPTIONS.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>
              <SettingsField
                label="Side margin (mm)"
                hint="0 = automatic (5 mm on rolls, 12 mm on sheets)"
              >
                <Input
                  inputMode="numeric"
                  value={numberDrafts.marginMm}
                  onChange={(e) => editNumber("marginMm", e.target.value)}
                  onBlur={() => commitNumber("marginMm", 0, 40, 0)}
                  placeholder="0"
                />
              </SettingsField>
              {settings.paper === "a4" &&
                settings.background &&
                settings.showLogo && (
                  <SettingsField
                    label="A4 letterhead content starts (mm)"
                    hint="Increase this if your uploaded letterhead header overlaps bill details."
                  >
                    <Input
                      inputMode="numeric"
                      value={numberDrafts.a4ContentTopMm}
                      onChange={(e) =>
                        editNumber("a4ContentTopMm", e.target.value)
                      }
                      onBlur={() => commitNumber("a4ContentTopMm", 40, 140, 68)}
                      placeholder="68"
                    />
                  </SettingsField>
                )}
            </SettingsGrid>
          </SettingsGroup>

          <Separator />

          <SettingsGroup
            title="3 · Paper & printer"
            hint="Optional shortcut: pick a printer model to fill in paper size, darkness and spacing. Everything stays editable."
          >
            <Select
              value=""
              onValueChange={(id) => {
                const preset = PRINTER_PRESETS.find((p) => p.id === id);
                if (!preset) return;
                save({ ...settings, ...preset.settings });
                toast.success(`Applied "${preset.label}" printer settings`);
              }}
            >
              <SelectTrigger className="w-full max-w-xl">
                <SelectValue placeholder="Choose a printer to auto-fill the fields below…" />
              </SelectTrigger>
              <SelectContent>
                {PRINTER_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <SettingsGrid>
              <SettingsField label="Paper / printer type">
                <Select
                  value={settings.paper}
                  onValueChange={(v) => set("paper", v as PaperId)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAPER_TYPES.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>
              {settings.paper === "custom" && (
                <SettingsField
                  label="Custom roll width (mm)"
                  hint="Between 50 and 300 mm."
                >
                  <Input
                    inputMode="numeric"
                    value={numberDrafts.customWidthMm}
                    onChange={(e) =>
                      editNumber("customWidthMm", e.target.value)
                    }
                    onBlur={() => commitNumber("customWidthMm", 50, 300, 72)}
                    placeholder="e.g. 72"
                  />
                </SettingsField>
              )}
              <SettingsField label="Copies per print" hint="1 to 5 copies.">
                <Input
                  inputMode="numeric"
                  value={numberDrafts.copies}
                  onChange={(e) => editNumber("copies", e.target.value)}
                  onBlur={() => commitNumber("copies", 1, 5, 1, true)}
                />
              </SettingsField>
              <SettingsField label="Print darkness">
                <Select
                  value={settings.density}
                  onValueChange={(v) => set("density", v as DensityId)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DENSITY_OPTIONS.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsField>
              {rollPaper && (
                <SettingsField
                  label="Feed before cut (mm)"
                  hint="Blank paper fed after each bill."
                >
                  <Input
                    inputMode="numeric"
                    value={numberDrafts.cutFeedMm}
                    onChange={(e) => editNumber("cutFeedMm", e.target.value)}
                    onBlur={() => commitNumber("cutFeedMm", 0, 40, 0)}
                    placeholder="0"
                  />
                </SettingsField>
              )}
            </SettingsGrid>
          </SettingsGroup>

          <Separator />

          <SettingsGroup title="4 · Receipt content">
            <SettingsGrid>
              <SettingsField label="Header line">
                <Input
                  value={settings.headerLine}
                  onChange={(e) => set("headerLine", e.target.value)}
                />
              </SettingsField>
              <SettingsField label="Footer line">
                <Input
                  value={settings.footerLine}
                  onChange={(e) => set("footerLine", e.target.value)}
                />
              </SettingsField>
              <SettingsField label="Currency symbol">
                <Input
                  value={settings.currencySymbol}
                  onChange={(e) =>
                    set("currencySymbol", e.target.value.slice(0, 4))
                  }
                  placeholder="Rs"
                />
              </SettingsField>
              <div className="sm:col-span-2 xl:col-span-3">
                <SettingsSwitchRow
                  label="Print customer phone"
                  checked={settings.showPhone}
                  onCheckedChange={(v) => set("showPhone", v)}
                />
              </div>
              <SettingsField
                label="UPI ID for Scan & Pay"
                hint="Adds a UPI QR code to the premium A4/A5/80mm layouts. Leave blank to hide it."
              >
                <Input
                  value={settings.upiId}
                  onChange={(e) => {
                    const v = e.target.value.slice(0, 80);
                    set("upiId", v);
                    const handle = v.includes("@")
                      ? v.split("@")[1]?.trim()
                      : null;
                    if (handle && !settings.upiPayeeName?.trim()) {
                      set("upiPayeeName", handle);
                    }
                    if (handle && !settings.upiBankHandle?.trim()) {
                      set("upiBankHandle", handle);
                    }
                  }}
                  placeholder="yourshop@upi"
                />
              </SettingsField>
              {settings.upiId?.includes("@") && (
                <p className="text-xs text-muted-foreground">
                  Bank handle:{" "}
                  <span className="font-medium">
                    {settings.upiId.split("@")[1]?.trim()}
                  </span>{" "}
                  - auto-filled as Payee name (edit it in the Payee name dialog
                  to match your bank record exactly, else payers see the
                  could-not-load-banking-name warning).
                </p>
              )}
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">UPI ID (VPA)</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {settings.upiId?.trim() || "Not set"}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setVpaOpen(true)}
                >
                  Change
                </Button>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Payee name</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {settings.upiPayeeName?.trim() || settings.shopName}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPayeeOpen(true)}
                >
                  Change
                </Button>
              </div>
              <SettingsSwitchRow
                label="Prefill amount in UPI QR / link"
                hint="On: the payer's UPI app opens with the bill amount filled in. Off: the payer types the amount themselves (useful for advances and part payments)."
                checked={settings.upiPrefillAmount}
                onCheckedChange={(v) => set("upiPrefillAmount", v)}
              />
              {settings.upiId &&
                !/^[\w.-]{2,}@[a-zA-Z]{2,}/.test(settings.upiId) && (
                  <p className="text-xs text-amber-600">
                    UPI ID should look like name@okhdfcbank - a bank handle
                    after @ is required, otherwise payers get the name warning.
                  </p>
                )}
              <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">
                  Examples (Indian UPI)
                </p>
                <p>
                  <span className="font-medium">UPI ID:</span>{" "}
                  chennaisoccer@okhdfcbank, cssports@ybl, chennai.soccer@icici -
                  the part after @ is your bank's handle; copy the VPA exactly
                  from your bank app.
                </p>
                <p>
                  <span className="font-medium">Payee name:</span> CHENNAI
                  SOCCER AND SPORTS SCHOOL - exactly as printed on your bank
                  statement / UPI profile, not a short form or nickname.
                </p>
                <p>
                  When both match the bank's records, GPay / PhonePe show this
                  name on scan - the "could not load banking name" warning
                  disappears.
                </p>
              </div>
              <SettingsField
                label="UPI apps shown"
                hint="Which app names print under the QR code. Defaults to Google Pay + PhonePe."
                full
              >
                <div className="flex flex-wrap gap-4">
                  {UPI_APPS.map((app) => (
                    <label
                      key={app.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={settings.upiApps.includes(app.id)}
                        onCheckedChange={(checked) => {
                          const next: UpiAppId[] = checked
                            ? [...settings.upiApps, app.id]
                            : settings.upiApps.filter((id) => id !== app.id);
                          // Keep at least one app checked — an empty list
                          // would otherwise silently fall back to the
                          // Google Pay + PhonePe default, leaving the checkboxes
                          // out of sync with what actually prints.
                          if (next.length) set("upiApps", next);
                        }}
                      />
                      {app.name}
                    </label>
                  ))}
                </div>
              </SettingsField>
            </SettingsGrid>
          </SettingsGroup>

          <Separator />

          <SettingsGroup title="5 · Output options">
            <div className="grid gap-2 lg:grid-cols-2">
              <SettingsSwitchRow
                label="Auto-print after saving a bill"
                checked={settings.autoPrint}
                onCheckedChange={(v) => set("autoPrint", v)}
              />
              <SettingsSwitchRow
                label="Preview before printing"
                // printReceipt() (receipt.ts) branches on isAndroid() before
                // it ever checks previewBeforePrint — every print on Android
                // already saves the PDF and opens it in the native viewer
                // first (Android WebView can't silently print), so this
                // setting has no separate effect there. Disabling it here
                // instead of leaving it live-but-inert, which used to let
                // someone toggle it off expecting a direct print and see no
                // change.
                hint={
                  isAndroid()
                    ? "Always on for this device — printing opens the PDF viewer first"
                    : "Opens in a tab instead of printing right away"
                }
                checked={isAndroid() ? true : settings.previewBeforePrint}
                onCheckedChange={(v) => set("previewBeforePrint", v)}
                disabled={isAndroid()}
              />
            </div>
          </SettingsGroup>

          <Separator />

          <SettingsGroup
            title="Test and reset"
            hint="Previews use the settings above and the same builders as real Print, PDF and Share."
          >
            <div
              role="radiogroup"
              aria-label="Document to preview"
              className="flex flex-wrap gap-2"
            >
              {SAMPLE_DOCUMENT_OPTIONS.map((o) => (
                <Button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={sampleKind === o.id}
                  variant={sampleKind === o.id ? "default" : "outline"}
                  className="h-11 [@media(pointer:fine)]:sm:h-9"
                  onClick={() => setSampleKind(o.id)}
                >
                  {o.label}
                </Button>
              ))}
            </div>
            <SettingsActions>
              <Button
                variant="outline"
                onClick={() => printReceipt(sample, settings)}
              >
                <Printer className="mr-1 h-4 w-4" /> Test print
              </Button>
              <Button
                variant="outline"
                onClick={() => void previewReceipt(sample, settings)}
              >
                <Eye className="mr-1 h-4 w-4" /> Preview layout
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  save(DEFAULT_PRINT_SETTINGS);
                  toast.success("Reset to premium thermal 80 mm default");
                }}
              >
                <RotateCcw className="mr-1 h-4 w-4" /> Reset defaults
              </Button>
            </SettingsActions>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Tip: try the printer shortcut in Paper & printer first, then
                fine-tune darkness or spacing if receipts print too light or too
                cramped.
              </span>
            </p>
          </SettingsGroup>
        </CardContent>
      </Card>

      <Dialog open={vpaOpen} onOpenChange={setVpaOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>UPI ID (VPA)</DialogTitle>
            <DialogDescription>
              The name registered at your bank for this UPI ID. GPay / PhonePe
              show it on scan; if it differs from the bank record, payers see
              the could-not-load-banking-name warning.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="bank-handle-input">Bank handle (editable)</Label>
              <Input
                id="bank-handle-input"
                value={settings.upiBankHandle}
                onChange={(e) =>
                  set("upiBankHandle", e.target.value.slice(0, 40))
                }
                placeholder={
                  settings.upiId?.includes("@")
                    ? settings.upiId.split("@")[1]?.trim()
                    : "e.g. okhdfcbank"
                }
              />
              <p className="text-xs text-muted-foreground">
                The part after @ in your UPI ID. Used for the
                could-not-load-banking-name check - set it to your bank's real
                handle if the VPA suffix differs.
              </p>
              <Label htmlFor="vpa-payee-name">
                Payee name (as registered at bank)
              </Label>
              <Input
                id="vpa-payee-name"
                value={settings.upiPayeeName}
                onChange={(e) =>
                  set("upiPayeeName", e.target.value.slice(0, 99))
                }
                placeholder={settings.shopName}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVpaOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={payeeOpen} onOpenChange={setPayeeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Payee name</DialogTitle>
            <DialogDescription>
              The name registered at your bank for this UPI ID. GPay / PhonePe
              show it on scan; if it differs from the bank record, payers see
              the could-not-load-banking-name warning.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="payee-name-input">
                Payee name (as registered at bank)
              </Label>
              <Input
                id="payee-name-input"
                value={settings.upiPayeeName}
                onChange={(e) =>
                  set("upiPayeeName", e.target.value.slice(0, 99))
                }
                placeholder={settings.shopName}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayeeOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
