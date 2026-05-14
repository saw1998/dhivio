import type { Database } from "@carbon/database";
import type { JSONContent } from "@carbon/react";
import { formatDate, isEoriCountry } from "@carbon/utils";
import { Image, Text, View } from "@react-pdf/renderer";
import { createTw } from "react-pdf-tailwind";
import type { AccountsPayableBillingAddress, PDF } from "../types";
import { composeRegistrationLine } from "../utils/footer";
import {
  getLineDescription,
  getLineDescriptionDetails,
  getLineTotal,
  getTotal
} from "../utils/purchase-order";
import { formatTaxPercent } from "../utils/shared";
import { AddressBlock, Header, Note, Template } from "./components";

const INDIRECT_TYPES = new Set([
  "Service",
  "G/L Account",
  "Fixed Asset",
  "Comment"
]);
const isIndirect = (t: string | null | undefined) =>
  !!t && INDIRECT_TYPES.has(t);

interface PurchaseOrderPDFProps extends PDF {
  purchaseOrder: Database["public"]["Views"]["purchaseOrders"]["Row"];
  purchaseOrderLines: Database["public"]["Views"]["purchaseOrderLines"]["Row"][];
  purchaseOrderLocations: Database["public"]["Views"]["purchaseOrderLocations"]["Row"];
  companySettings?:
    | Database["public"]["Tables"]["companySettings"]["Row"]
    | null;
  accountsPayableBillingAddress?: AccountsPayableBillingAddress | null;
  paymentTerms?: { id: string; name: string }[];
  terms: JSONContent;
  thumbnails?: Record<string, string | null>;
}

const tw = createTw({
  theme: {
    fontFamily: {
      sans: ["Inter", "Helvetica", "Arial", "sans-serif"]
    },
    extend: {
      colors: {
        gray: {
          50: "#f9fafb",
          200: "#e5e7eb",
          400: "#9ca3af",
          600: "#4b5563",
          800: "#1f2937"
        }
      }
    }
  }
});

const PurchaseOrderPDF = ({
  accountsPayableBillingAddress,
  company,
  companySettings,
  meta,
  paymentTerms,
  purchaseOrder,
  purchaseOrderLines,
  purchaseOrderLocations,
  terms,
  thumbnails,
  locale,
  title = "Purchase Order"
}: PurchaseOrderPDFProps) => {
  const {
    supplierName,
    supplierAddressLine1,
    supplierAddressLine2,
    supplierCity,
    supplierStateProvince,
    supplierPostalCode,
    supplierCountryCode,
    deliveryName,
    deliveryAddressLine1,
    deliveryAddressLine2,
    deliveryCity,
    deliveryStateProvince,
    deliveryPostalCode,
    deliveryCountryCode,
    dropShipment,
    customerName,
    customerAddressLine1,
    customerAddressLine2,
    customerCity,
    customerStateProvince,
    customerPostalCode,
    customerCountryCode
  } = purchaseOrderLocations;

  const currencyCode =
    purchaseOrder.currencyCode ?? company.baseCurrencyCode ?? "USD";
  const numberFormatter = new Intl.NumberFormat(locale, {
    style: "decimal",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const taxAmount = purchaseOrderLines.reduce(
    (acc, line) => acc + (line.supplierTaxAmount ?? 0),
    0
  );

  const shippingCost = purchaseOrder?.supplierShippingCost ?? 0;
  const paymentTerm = paymentTerms?.find(
    (term) => term.id === purchaseOrder?.paymentTermId
  );

  const watermarkSrc = company.logoWatermark;

  const shipAddress = dropShipment
    ? {
        name: customerName,
        addressLine1: customerAddressLine1,
        addressLine2: customerAddressLine2,
        city: customerCity,
        stateProvince: customerStateProvince,
        postalCode: customerPostalCode,
        countryCode: customerCountryCode
      }
    : {
        name: deliveryName,
        addressLine1: deliveryAddressLine1,
        addressLine2: deliveryAddressLine2,
        city: deliveryCity,
        stateProvince: deliveryStateProvince,
        postalCode: deliveryPostalCode,
        countryCode: deliveryCountryCode
      };

  const headerTitle = purchaseOrder?.purchaseOrderId
    ? `${title}: ${purchaseOrder.purchaseOrderId}`
    : title;

  const registrationLine = composeRegistrationLine({
    companyName: company.name,
    country: purchaseOrderLocations.companyCountryName ?? company.countryCode,
    eori: company.eori
  });

  let rowIndex = 0;

  return (
    <Template
      title={headerTitle}
      meta={{
        author: meta?.author ?? "Dhivio",
        keywords: meta?.keywords ?? "purchase order",
        subject: meta?.subject ?? "Purchase Order"
      }}
      footerDocumentId={purchaseOrder?.purchaseOrderId}
      footerLabel={registrationLine ?? undefined}
    >
      {watermarkSrc && (
        <View
          fixed
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: "center",
            marginTop: 100,
            opacity: 0.07
          }}
        >
          <Image src={watermarkSrc} style={{ width: "50%" }} />
        </View>
      )}
      <Header
        company={company}
        title={title}
        documentId={purchaseOrder?.purchaseOrderId}
        locale={locale}
        fixed
      />

      {/* Body row — Supplier (left) | Right-column stack */}
      <View style={tw("border border-gray-200 mb-4")}>
        <View style={tw("flex flex-row")}>
          {/* LEFT — Supplier block (full content with address) */}
          <View style={tw("w-1/2 p-3 border-r border-gray-200")}>
            <Text
              style={tw("text-[9px] font-bold text-gray-600 mb-1 uppercase")}
            >
              Supplier
            </Text>
            <View style={tw("text-[9px] text-gray-800")}>
              <AddressBlock
                name={supplierName}
                addressLine1={supplierAddressLine1}
                addressLine2={supplierAddressLine2}
                city={supplierCity}
                stateProvince={supplierStateProvince}
                postalCode={supplierPostalCode}
                countryCode={supplierCountryCode}
              />
              {purchaseOrderLocations.supplierTaxId &&
                !isEoriCountry(supplierCountryCode) && (
                  <Text>Tax ID: {purchaseOrderLocations.supplierTaxId}</Text>
                )}
              {purchaseOrderLocations.supplierVatNumber && (
                <Text>VAT: {purchaseOrderLocations.supplierVatNumber}</Text>
              )}
              {purchaseOrderLocations.supplierEori && (
                <Text>EORI: {purchaseOrderLocations.supplierEori}</Text>
              )}
              {purchaseOrderLocations.supplierContactName && (
                <Text>
                  Contact: {purchaseOrderLocations.supplierContactName}
                </Text>
              )}
              {purchaseOrderLocations.supplierContactEmail && (
                <Text>
                  Email: {purchaseOrderLocations.supplierContactEmail}
                </Text>
              )}
            </View>
          </View>

          {/* RIGHT — three stacked sub-blocks */}
          <View style={tw("w-1/2 flex flex-col")}>
            {/* Order Info — merges Order Details + Buyer Contact */}
            <View style={tw("p-3 border-b border-gray-200")}>
              <Text
                style={tw("text-[9px] font-bold text-gray-600 mb-1 uppercase")}
              >
                Order Info
              </Text>
              <View style={tw("text-[9px] text-gray-800")}>
                {purchaseOrder?.purchaseOrderId && (
                  <Text>PO Number: {purchaseOrder.purchaseOrderId}</Text>
                )}
                {purchaseOrder?.orderDate && (
                  <Text>
                    Date:{" "}
                    {formatDate(purchaseOrder.orderDate, undefined, locale)}
                  </Text>
                )}
                <Text>Currency: {currencyCode}</Text>
                {purchaseOrder?.supplierReference && (
                  <Text>Reference: {purchaseOrder.supplierReference}</Text>
                )}
                {purchaseOrder?.receiptRequestedDate && (
                  <Text>
                    Requested:{" "}
                    {formatDate(
                      purchaseOrder.receiptRequestedDate,
                      undefined,
                      locale
                    )}
                  </Text>
                )}
                {purchaseOrder?.receiptPromisedDate && (
                  <Text>
                    Promised:{" "}
                    {formatDate(
                      purchaseOrder.receiptPromisedDate,
                      undefined,
                      locale
                    )}
                  </Text>
                )}
                {paymentTerm && <Text>Payment Terms: {paymentTerm.name}</Text>}
                {purchaseOrder?.incoterm && (
                  <Text>
                    Incoterm: {purchaseOrder.incoterm}
                    {purchaseOrder.incotermLocation
                      ? ` — ${purchaseOrder.incotermLocation}`
                      : ""}
                  </Text>
                )}
              </View>
              {/* Thin divider between Order Details and Buyer Contact halves */}
              <View style={tw("h-[1px] bg-gray-200 my-2")} />
              <View style={tw("text-[9px] text-gray-800")}>
                {company.vatNumber && <Text>VAT: {company.vatNumber}</Text>}
                {purchaseOrder.createdByFullName && (
                  <Text>Contact: {purchaseOrder.createdByFullName}</Text>
                )}
                {purchaseOrder.createdByEmail && (
                  <Text>Email: {purchaseOrder.createdByEmail}</Text>
                )}
                {purchaseOrder.createdByPhone && (
                  <Text>Phone: {purchaseOrder.createdByPhone}</Text>
                )}
                {accountsPayableBillingAddress?.email && (
                  <Text style={tw("font-bold")}>
                    Billing documents and enquiries to:{" "}
                    {accountsPayableBillingAddress.email}
                  </Text>
                )}
              </View>
            </View>

            {/* Deliver To */}
            <View style={tw("p-3")}>
              <Text
                style={tw("text-[9px] font-bold text-gray-600 mb-1 uppercase")}
              >
                Deliver To
              </Text>
              <View style={tw("text-[9px] text-gray-800")}>
                <AddressBlock {...shipAddress} />
              </View>
            </View>
          </View>
        </View>
      </View>

      {/* Notes (full width, always rendered for layout predictability) */}
      <View style={tw("border border-gray-200 mb-4")}>
        <View style={tw("p-3")}>
          <Text style={tw("text-[9px] font-bold text-gray-600 mb-1 uppercase")}>
            Notes
          </Text>
          <View style={tw("text-[9px] text-gray-800")}>
            {Object.keys(purchaseOrder?.externalNotes ?? {}).length > 0 ? (
              <Note
                content={(purchaseOrder.externalNotes ?? {}) as JSONContent}
              />
            ) : (
              <Text style={tw("text-gray-400")}>None</Text>
            )}
          </View>
        </View>
      </View>

      {/* Line Items Table */}
      <View style={tw("mb-4")}>
        {/* Header — fixed so it repeats on every page the table spans */}
        <View
          fixed
          style={tw(
            "flex flex-row bg-gray-800 py-3 px-3 text-white text-[9px] font-bold items-center"
          )}
        >
          <Text style={tw("w-[4%] text-center")}>#</Text>
          <Text style={tw("w-[22%]")}>Description</Text>
          <Text style={tw("w-[8%] text-center")}>Qty</Text>
          <Text style={tw("w-[7%] text-center")}>UOM</Text>
          <View style={tw("w-[10%] items-center")}>
            <Text>Required</Text>
          </View>
          <View style={tw("w-[12%] items-center")}>
            <Text>Unit Price</Text>
            <Text style={[tw("text-[7px] font-normal"), { opacity: 0.7 }]}>
              {currencyCode}
            </Text>
          </View>
          <View style={tw("w-[12%] items-center")}>
            <Text>Net Value</Text>
            <Text style={[tw("text-[7px] font-normal"), { opacity: 0.7 }]}>
              {currencyCode}
            </Text>
          </View>
          <View style={tw("w-[12%] items-center")}>
            <Text>Tax Value</Text>
            <Text style={[tw("text-[7px] font-normal"), { opacity: 0.7 }]}>
              {currencyCode}
            </Text>
          </View>
          <View style={tw("w-[13%] items-center")}>
            <Text>Total</Text>
            <Text style={[tw("text-[7px] font-normal"), { opacity: 0.7 }]}>
              {currencyCode}
            </Text>
          </View>
        </View>

        {/* Rows */}
        {purchaseOrderLines.map((line) => {
          const isEven = rowIndex % 2 === 0;
          rowIndex++;

          const netValue =
            (line.purchaseQuantity ?? 0) * (line.supplierUnitPrice ?? 0);

          return (
            <View key={line.id} wrap={false}>
              <View
                style={[
                  tw(
                    "flex flex-col py-2 px-3 border-b border-gray-200 text-[9px]"
                  ),
                  {
                    backgroundColor: isEven
                      ? "transparent"
                      : "rgba(249, 250, 251, 0.6)"
                  }
                ]}
              >
                <View style={tw("flex flex-row")}>
                  <Text style={tw("w-[4%] text-center text-gray-400")}>
                    {line.purchaseOrderLineType === "Comment" ? "" : rowIndex}
                  </Text>
                  <View style={tw("w-[22%] pr-2")}>
                    {isIndirect(line.purchaseOrderLineType) ? (
                      <Text style={tw("text-gray-900")}>
                        {line.description ?? ""}
                      </Text>
                    ) : (
                      <>
                        <Text style={tw("text-gray-900")}>
                          {getLineDescription(line)}
                        </Text>
                        <Text style={tw("text-[7px] text-gray-600 mt-0.5")}>
                          {getLineDescriptionDetails(line)}
                        </Text>
                      </>
                    )}
                    {purchaseOrder.purchaseOrderType === "Outside Processing" &&
                      line.jobOperationDescription && (
                        <Text style={tw("text-[7px] text-gray-600 mt-0.5")}>
                          {line.jobOperationDescription}
                        </Text>
                      )}
                    {thumbnails &&
                      line.id &&
                      line.id in thumbnails &&
                      thumbnails[line.id] && (
                        <View style={tw("mt-1 w-16")}>
                          <Image
                            src={thumbnails[line.id]!}
                            style={tw("w-full h-auto")}
                          />
                        </View>
                      )}
                  </View>
                  <Text style={tw("w-[8%] text-center text-gray-600")}>
                    {line.purchaseOrderLineType === "Comment"
                      ? ""
                      : line.purchaseQuantity}
                  </Text>
                  <Text style={tw("w-[7%] text-center text-gray-600")}>
                    {line.purchaseOrderLineType === "Comment"
                      ? ""
                      : line.purchaseUnitOfMeasureCode}
                  </Text>
                  <Text style={tw("w-[10%] text-center text-gray-600")}>
                    {line.purchaseOrderLineType === "Comment" ||
                    !line.requiredDate
                      ? ""
                      : formatDate(line.requiredDate, undefined, locale)}
                  </Text>
                  <Text style={tw("w-[12%] text-center text-gray-600")}>
                    {line.purchaseOrderLineType === "Comment"
                      ? ""
                      : numberFormatter.format(line.supplierUnitPrice ?? 0)}
                  </Text>
                  <Text style={tw("w-[12%] text-center text-gray-600")}>
                    {line.purchaseOrderLineType === "Comment"
                      ? ""
                      : numberFormatter.format(netValue)}
                  </Text>
                  <View style={tw("w-[12%]")}>
                    {line.purchaseOrderLineType !== "Comment" && (
                      <View style={tw("flex flex-col items-center")}>
                        <Text style={tw("text-gray-600")}>
                          {numberFormatter.format(line.supplierTaxAmount ?? 0)}
                        </Text>
                        {formatTaxPercent(line.taxPercent) && (
                          <Text style={tw("text-[6px] text-gray-400")}>
                            {formatTaxPercent(line.taxPercent)}
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                  <Text
                    style={tw("w-[13%] text-center text-gray-800 font-medium")}
                  >
                    {line.purchaseOrderLineType === "Comment"
                      ? ""
                      : numberFormatter.format(getLineTotal(line))}
                  </Text>
                </View>
              </View>
              {Object.keys(line.externalNotes ?? {}).length > 0 && (
                <View style={tw("px-3 py-2 border-b border-gray-200")}>
                  <Note
                    key={`${line.id}-notes`}
                    content={line.externalNotes as JSONContent}
                  />
                </View>
              )}
            </View>
          );
        })}

        {/* Summary */}
        <View>
          {/* Subtotal */}
          <View
            style={[
              tw("flex flex-row py-1.5 px-3 text-[9px]"),
              { backgroundColor: "rgba(249, 250, 251, 0.6)" }
            ]}
          >
            <Text style={tw("w-[80%] text-right pr-3 text-gray-600")}>
              Subtotal ({currencyCode})
            </Text>
            <Text style={tw("w-[20%] text-right text-gray-800")}>
              {numberFormatter.format(
                purchaseOrderLines.reduce((sum, line) => {
                  if (line?.purchaseQuantity && line?.supplierUnitPrice) {
                    return sum + line.purchaseQuantity * line.supplierUnitPrice;
                  }
                  return sum;
                }, 0)
              )}
            </Text>
          </View>

          {/* Shipping */}
          {shippingCost > 0 && (
            <View
              style={[
                tw("flex flex-row py-1.5 px-3 text-[9px]"),
                { backgroundColor: "rgba(249, 250, 251, 0.6)" }
              ]}
            >
              <Text style={tw("w-[80%] text-right pr-3 text-gray-600")}>
                Shipping ({currencyCode})
              </Text>
              <Text style={tw("w-[20%] text-right text-gray-800")}>
                {numberFormatter.format(shippingCost)}
              </Text>
            </View>
          )}

          {/* Tax — amount only, no percentage subtext */}
          {taxAmount > 0 && (
            <View
              style={[
                tw("flex flex-row py-1.5 px-3 text-[9px]"),
                { backgroundColor: "rgba(249, 250, 251, 0.6)" }
              ]}
            >
              <Text style={tw("w-[80%] text-right pr-3 text-gray-600")}>
                Tax ({currencyCode})
              </Text>
              <Text style={tw("w-[20%] text-right text-gray-800")}>
                {numberFormatter.format(taxAmount)}
              </Text>
            </View>
          )}

          <View style={tw("h-[1px] bg-gray-200")} />
          <View style={tw("flex flex-row py-2 px-3 text-[9px]")}>
            <Text style={tw("w-[80%] text-right pr-3 text-gray-800 font-bold")}>
              Total
            </Text>
            <Text style={tw("w-[20%] text-right text-gray-800 font-bold")}>
              {currencyCode}{" "}
              {numberFormatter.format(
                getTotal(purchaseOrderLines) + shippingCost
              )}
            </Text>
          </View>
        </View>
      </View>

      {/* Terms */}
      {terms?.content && terms.content.length > 0 && (
        <View break>
          <View style={tw("border-b border-gray-400 mb-3 pb-2 mt-2")}>
            <Text
              style={tw(
                "text-[14px] font-bold text-gray-800 uppercase tracking-wide"
              )}
            >
              Terms & Conditions
            </Text>
          </View>
          <Note content={terms} />
        </View>
      )}
    </Template>
  );
};

export default PurchaseOrderPDF;
