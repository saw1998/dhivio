import type { Database } from "@carbon/database";
import type { JSONContent } from "@carbon/react";
import { formatDate, isEoriCountry } from "@carbon/utils";
import { Image, Text, View } from "@react-pdf/renderer";
import { createTw } from "react-pdf-tailwind";
import type { AccountsReceivableBillingAddress, PDF } from "../types";
import { composeRegistrationLine } from "../utils/footer";
import {
  getLineDescription,
  getLineDescriptionDetails,
  getLineTaxableSubtotal,
  getLineTotal,
  getTotal
} from "../utils/sales-order";
import { AddressBlock, Header, Note, Template } from "./components";

type SalesOrderLocations =
  Database["public"]["Views"]["salesOrderLocations"]["Row"] & {
    customerTaxId?: string | null;
    customerVatNumber?: string | null;
  };

interface SalesOrderPDFProps extends PDF {
  salesOrder: Database["public"]["Views"]["salesOrders"]["Row"];
  salesOrderLines: Database["public"]["Views"]["salesOrderLines"]["Row"][];
  salesOrderLocations: SalesOrderLocations;
  companySettings?:
    | Database["public"]["Tables"]["companySettings"]["Row"]
    | null;
  accountsReceivableBillingAddress?: AccountsReceivableBillingAddress | null;
  paymentTerms: { id: string; name: string }[];
  shippingMethods: { id: string; name: string }[];
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

const SalesOrderPDF = ({
  accountsReceivableBillingAddress,
  company,
  companySettings,
  meta,
  salesOrder,
  salesOrderLines,
  salesOrderLocations,
  terms,
  paymentTerms,
  shippingMethods,
  thumbnails,
  locale,
  title = "Sales Order"
}: SalesOrderPDFProps) => {
  const {
    customerName,
    customerAddressLine1,
    customerAddressLine2,
    customerCity,
    customerStateProvince,
    customerPostalCode,
    customerCountryName,
    customerTaxId,
    customerVatNumber,
    customerEori,
    paymentCustomerName,
    paymentAddressLine1,
    paymentAddressLine2,
    paymentCity,
    paymentStateProvince,
    paymentPostalCode,
    paymentCountryName
  } = salesOrderLocations;

  const currencyCode = salesOrder.currencyCode ?? company.baseCurrencyCode;
  const numberFormatter = new Intl.NumberFormat(locale, {
    style: "decimal",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const registrationLine = composeRegistrationLine({
    companyName: company.name,
    country: company.countryCode,
    eori: company.eori,
    accountsReceivableEmail: companySettings?.accountsReceivableEmail
  });

  const paymentTerm = paymentTerms?.find(
    (term) => term.id === salesOrder?.paymentTermId
  );

  const shippingMethod = shippingMethods?.find(
    (method) => method.id === salesOrder?.shippingMethodId
  );

  const watermarkSrc = company.logoWatermark;

  let rowIndex = 0;

  return (
    <Template
      title={title}
      meta={{
        author: meta?.author ?? "Dhivio",
        keywords: meta?.keywords ?? "sales order",
        subject: meta?.subject ?? "Sales Order"
      }}
      footerDocumentId={salesOrder?.salesOrderId}
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
        title="Sales Order"
        documentId={salesOrder?.salesOrderId}
        currencyCode={salesOrder?.currencyCode}
        locale={locale}
      />

      {/* Body row — Customer (left) | Order Details + Ship To + Bill To stacked (right) */}
      <View style={tw("border border-gray-200 mb-4")}>
        <View style={tw("flex flex-row")}>
          {/* LEFT — Customer block */}
          <View style={tw("w-1/2 p-3 border-r border-gray-200")}>
            <Text
              style={tw("text-[9px] font-bold text-gray-600 mb-1 uppercase")}
            >
              Customer
            </Text>
            <View style={tw("text-[9px] text-gray-800")}>
              <AddressBlock
                name={customerName}
                addressLine1={customerAddressLine1}
                addressLine2={customerAddressLine2}
                city={customerCity}
                stateProvince={customerStateProvince}
                postalCode={customerPostalCode}
                countryCode={customerCountryName}
              />
              {customerTaxId && !isEoriCountry(customerCountryName) && (
                <Text>Tax ID: {customerTaxId}</Text>
              )}
              {customerVatNumber && <Text>VAT: {customerVatNumber}</Text>}
              {customerEori && <Text>EORI: {customerEori}</Text>}
            </View>
          </View>

          {/* RIGHT — Order Details + Ship To + Bill To stacked */}
          <View style={tw("w-1/2 flex flex-col")}>
            {/* Order Details */}
            <View
              style={tw(
                paymentCustomerName ? "p-3 border-b border-gray-200" : "p-3"
              )}
            >
              <Text
                style={tw("text-[9px] font-bold text-gray-600 mb-1 uppercase")}
              >
                Order Details
              </Text>
              <View style={tw("text-[9px] text-gray-800")}>
                {salesOrder?.orderDate && (
                  <Text>
                    Date: {formatDate(salesOrder.orderDate, undefined, locale)}
                  </Text>
                )}
                {salesOrder?.customerReference && (
                  <Text>Customer Ref: {salesOrder.customerReference}</Text>
                )}
                {salesOrder?.receiptRequestedDate && (
                  <Text>
                    Requested:{" "}
                    {formatDate(
                      salesOrder.receiptRequestedDate,
                      undefined,
                      locale
                    )}
                  </Text>
                )}
                {salesOrder?.receiptPromisedDate && (
                  <Text>
                    Promised:{" "}
                    {formatDate(
                      salesOrder.receiptPromisedDate,
                      undefined,
                      locale
                    )}
                  </Text>
                )}
                {paymentTerm && <Text>Payment Terms: {paymentTerm.name}</Text>}
                {shippingMethod && <Text>Shipping: {shippingMethod.name}</Text>}
                {salesOrder?.shippingTermName && (
                  <Text>Shipping Terms: {salesOrder.shippingTermName}</Text>
                )}
                {salesOrder?.incoterm && (
                  <Text>
                    Incoterm: {salesOrder.incoterm}
                    {salesOrder.incotermLocation
                      ? ` — ${salesOrder.incotermLocation}`
                      : ""}
                  </Text>
                )}
              </View>
            </View>

            {/* Bill To (only if a separate billing customer is set) */}
            {paymentCustomerName && (
              <View style={tw("p-3")}>
                <Text
                  style={tw(
                    "text-[9px] font-bold text-gray-600 mb-1 uppercase"
                  )}
                >
                  Bill To
                </Text>
                <View style={tw("text-[9px] text-gray-800")}>
                  <AddressBlock
                    name={paymentCustomerName}
                    addressLine1={paymentAddressLine1}
                    addressLine2={paymentAddressLine2}
                    city={paymentCity}
                    stateProvince={paymentStateProvince}
                    postalCode={paymentPostalCode}
                    countryCode={paymentCountryName}
                  />
                </View>
              </View>
            )}
          </View>
        </View>
      </View>

      {/* Notes (full width) */}
      <View style={tw("border border-gray-200 mb-4")}>
        <View style={tw("p-3")}>
          <Text style={tw("text-[9px] font-bold text-gray-600 mb-1 uppercase")}>
            Notes
          </Text>
          <View style={tw("text-[9px] text-gray-800")}>
            {Object.keys(salesOrder?.externalNotes ?? {}).length > 0 ? (
              <Note content={(salesOrder.externalNotes ?? {}) as JSONContent} />
            ) : (
              <Text style={tw("text-gray-400")}>None</Text>
            )}
          </View>
        </View>
      </View>

      {/* Line Items Table */}
      <View style={tw("mb-4")}>
        {/* Header */}
        <View
          fixed
          style={tw(
            "flex flex-row bg-gray-800 py-2 px-3 text-white text-[9px] font-bold items-center"
          )}
        >
          <Text style={tw("w-1/2")}>Description</Text>
          <Text style={tw("w-1/6 text-center")}>Qty</Text>
          <View style={tw("w-1/6 items-center")}>
            <Text>Unit Price</Text>
            <Text style={[tw("text-[7px] font-normal"), { opacity: 0.7 }]}>
              {currencyCode}
            </Text>
          </View>
          <View style={tw("w-1/6 items-center")}>
            <Text>Total</Text>
            <Text style={[tw("text-[7px] font-normal"), { opacity: 0.7 }]}>
              {currencyCode}
            </Text>
          </View>
        </View>

        {/* Rows */}
        {salesOrderLines.map((line) => {
          const isEven = rowIndex % 2 === 0;
          rowIndex++;

          const lineAddOnCost = line.convertedAddOnCost ?? 0;
          const lineNonTaxableAddOnCost =
            line.convertedNonTaxableAddOnCost ?? 0;
          const lineShippingCost = line.convertedShippingCost ?? 0;
          const lineTaxPercent = line.taxPercent ?? 0;
          const lineTaxAmount = getLineTaxableSubtotal(line) * lineTaxPercent;
          const totalTaxAndFees =
            lineAddOnCost +
            lineNonTaxableAddOnCost +
            lineShippingCost +
            lineTaxAmount;

          return (
            <View
              key={line.id}
              style={[
                tw(
                  "flex flex-row py-2 px-3 border-b border-gray-200 text-[10px]"
                ),
                {
                  backgroundColor: isEven
                    ? "transparent"
                    : "rgba(249, 250, 251, 0.6)"
                }
              ]}
              wrap={false}
            >
              <View style={tw("w-1/2 pr-2")}>
                <Text style={tw("text-gray-800")}>
                  {getLineDescription(line)}
                </Text>
                <Text style={tw("text-[8px] text-gray-400 mt-0.5")}>
                  {getLineDescriptionDetails(line)}
                </Text>
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
                {Object.keys(line.externalNotes ?? {}).length > 0 && (
                  <View style={tw("mt-1")}>
                    <Note
                      key={`${line.id}-notes`}
                      content={line.externalNotes as JSONContent}
                    />
                  </View>
                )}
                {line.salesOrderLineType !== "Comment" &&
                  totalTaxAndFees > 0 && (
                    <View style={tw("mt-1")}>
                      <Text style={tw("text-[8px] text-gray-400 font-bold")}>
                        Tax & Fees
                      </Text>
                      {lineShippingCost > 0 && (
                        <Text style={tw("text-[8px] text-gray-400")}>
                          - Shipping
                        </Text>
                      )}
                      {lineAddOnCost > 0 && (
                        <Text style={tw("text-[8px] text-gray-400")}>
                          - Add-On
                        </Text>
                      )}
                      {lineNonTaxableAddOnCost > 0 && (
                        <Text style={tw("text-[8px] text-gray-400")}>
                          - Non-Taxable Add-On
                        </Text>
                      )}
                      {lineTaxPercent > 0 && (
                        <Text style={tw("text-[8px] text-gray-400")}>
                          - Tax ({(lineTaxPercent * 100).toFixed(0)}%)
                        </Text>
                      )}
                    </View>
                  )}
              </View>
              <Text style={tw("w-1/6 text-center text-gray-600")}>
                {line.salesOrderLineType === "Comment"
                  ? ""
                  : `${line.saleQuantity} ${line.unitOfMeasureCode ?? "EA"}`}
              </Text>
              <Text style={tw("w-1/6 text-center text-gray-600")}>
                {line.salesOrderLineType === "Comment"
                  ? ""
                  : numberFormatter.format(line.convertedUnitPrice ?? 0)}
              </Text>
              <Text style={tw("w-1/6 text-center text-gray-800 font-medium")}>
                {line.salesOrderLineType === "Comment"
                  ? ""
                  : numberFormatter.format(getLineTotal(line))}
              </Text>
            </View>
          );
        })}

        {/* Summary */}
        <View>
          {/* Subtotal - extended price only */}
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
                salesOrderLines.reduce(
                  (sum, line) =>
                    sum +
                    (line.saleQuantity ?? 0) * (line.convertedUnitPrice ?? 0),
                  0
                )
              )}
            </Text>
          </View>

          {/* Add-Ons */}
          {salesOrderLines.some(
            (line) =>
              (line.convertedAddOnCost ?? 0) > 0 ||
              (line.convertedNonTaxableAddOnCost ?? 0) > 0
          ) && (
            <View
              style={[
                tw("flex flex-row py-1.5 px-3 text-[9px]"),
                { backgroundColor: "rgba(249, 250, 251, 0.6)" }
              ]}
            >
              <Text style={tw("w-[80%] text-right pr-3 text-gray-600")}>
                Add-Ons ({currencyCode})
              </Text>
              <Text style={tw("w-[20%] text-right text-gray-800")}>
                {numberFormatter.format(
                  salesOrderLines.reduce(
                    (sum, line) =>
                      sum +
                      (line.convertedAddOnCost ?? 0) +
                      (line.convertedNonTaxableAddOnCost ?? 0),
                    0
                  )
                )}
              </Text>
            </View>
          )}

          {/* Shipping */}
          {(() => {
            const lineShipping = salesOrderLines.reduce(
              (sum, line) => sum + (line.convertedShippingCost ?? 0),
              0
            );
            const orderShipping =
              (salesOrder.shippingCost ?? 0) * (salesOrder.exchangeRate ?? 1);
            const totalShipping = lineShipping + orderShipping;
            return totalShipping > 0 ? (
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
                  {numberFormatter.format(totalShipping)}
                </Text>
              </View>
            ) : null;
          })()}

          {/* Taxes */}
          {salesOrderLines.some((line) => (line.taxPercent ?? 0) > 0) && (
            <View
              style={[
                tw("flex flex-row py-1.5 px-3 text-[9px]"),
                { backgroundColor: "rgba(249, 250, 251, 0.6)" }
              ]}
            >
              <Text style={tw("w-[80%] text-right pr-3 text-gray-600")}>
                Taxes ({currencyCode})
              </Text>
              <Text style={tw("w-[20%] text-right text-gray-800")}>
                {numberFormatter.format(
                  salesOrderLines.reduce((sum, line) => {
                    const taxPercent = line.taxPercent ?? 0;
                    return sum + getLineTaxableSubtotal(line) * taxPercent;
                  }, 0)
                )}
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
              {numberFormatter.format(getTotal(salesOrderLines, salesOrder))}
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

export default SalesOrderPDF;
