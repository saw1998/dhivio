import type { Database } from "@carbon/database";
import type { JSONContent } from "@carbon/react";
import { formatDate, isEoriCountry, pluralize } from "@carbon/utils";
import { getLocalTimeZone, today } from "@internationalized/date";
import { Image, Text, View } from "@react-pdf/renderer";
import { createTw } from "react-pdf-tailwind";
import type { AccountsReceivableBillingAddress, PDF } from "../types";
import { composeRegistrationLine } from "../utils/footer";
import { getLineDescription, getLineDescriptionDetails } from "../utils/quote";
import { AddressBlock, Header, Note, Template } from "./components";

type QuoteCustomerDetails =
  Database["public"]["Views"]["quoteCustomerDetails"]["Row"] & {
    customerTaxId?: string | null;
    customerVatNumber?: string | null;
  };

interface QuotePDFProps extends PDF {
  exchangeRate: number;
  quote: Database["public"]["Views"]["quotes"]["Row"];
  quoteLines: Database["public"]["Views"]["quoteLines"]["Row"][];
  quoteCustomerDetails: QuoteCustomerDetails;
  quoteLinePrices: Database["public"]["Tables"]["quoteLinePrice"]["Row"][];
  payment?: Database["public"]["Tables"]["quotePayment"]["Row"] | null;
  shipment?: Database["public"]["Tables"]["quoteShipment"]["Row"] | null;
  accountsReceivableBillingAddress?: AccountsReceivableBillingAddress | null;
  companySettings?:
    | Database["public"]["Tables"]["companySettings"]["Row"]
    | null;
  paymentTerms: { id: string; name: string }[];
  shippingMethods: { id: string; name: string }[];
  terms: JSONContent;
  thumbnails: Record<string, string | null>;
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

const QuotePDF = ({
  accountsReceivableBillingAddress,
  company,
  companySettings,
  meta,
  exchangeRate,
  quote,
  quoteLines,
  quoteLinePrices,
  quoteCustomerDetails,
  payment,
  paymentTerms,
  shipment,
  terms,
  thumbnails,
  locale,
  title = "Quote"
}: QuotePDFProps) => {
  const {
    customerName,
    customerAddressLine1,
    customerAddressLine2,
    customerCity,
    customerStateProvince,
    customerPostalCode,
    customerCountryCode,
    customerTaxId,
    customerVatNumber,
    customerEori,
    contactName,
    contactEmail
  } = quoteCustomerDetails;

  const currencyCode = quote.currencyCode ?? company.baseCurrencyCode;
  const shouldConvertCurrency =
    !!currencyCode && currencyCode !== company.baseCurrencyCode;
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

  const pricesByLine = quoteLinePrices.reduce<
    Record<string, Database["public"]["Tables"]["quoteLinePrice"]["Row"][]>
  >((acc, price) => {
    if (!acc[price.quoteLineId]) {
      acc[price.quoteLineId] = [];
    }
    acc[price.quoteLineId]!.push(price);
    return acc;
  }, {});

  const paymentTerm = paymentTerms?.find(
    (pt) => pt.id === payment?.paymentTermId
  );

  const hasSinglePricePerLine = quoteLines.every(
    (line) => (line.quantity ?? []).length === 1
  );

  // Check if any line has a lead time > 0
  const hasAnyLeadTime = quoteLines.some((line) => {
    if (line.status === "No Quote") return false;
    const lineQuantity = line.quantity ?? [];
    const prices = line.id != null ? (pricesByLine[line.id] ?? []) : [];
    const price = prices.find(
      (p: Database["public"]["Tables"]["quoteLinePrice"]["Row"]) =>
        p.quantity === lineQuantity[0]
    );
    return price && price.leadTime > 0;
  });

  // Calculate column count for dynamic widths
  // Base columns: Qty, Unit Price, Total = 3
  // Optional: Tax & Fees (when multi-qty), Lead Time (when any has lead time)
  const columnCount =
    3 + (!hasSinglePricePerLine ? 1 : 0) + (hasAnyLeadTime ? 1 : 0);
  const colWidth =
    columnCount === 3 ? "w-1/3" : columnCount === 4 ? "w-1/4" : "w-1/5";

  const getMaxLeadTime = () => {
    let maxLeadTime = 0;
    for (const prices of Object.values(pricesByLine)) {
      for (const price of prices) {
        if (price && price.leadTime > maxLeadTime) {
          maxLeadTime = price.leadTime;
        }
      }
    }
    return maxLeadTime;
  };

  const getTotalSubtotal = () => {
    return quoteLines.reduce((total, line) => {
      if (line.status === "No Quote") return total;
      const lineQuantity = line.quantity ?? [];
      const prices = line.id != null ? (pricesByLine[line.id] ?? []) : [];
      const price = prices.find(
        (p: Database["public"]["Tables"]["quoteLinePrice"]["Row"]) =>
          p.quantity === lineQuantity[0]
      );
      return total + (price?.convertedNetExtendedPrice ?? 0);
    }, 0);
  };

  const getTotalShipping = () => {
    const lineShipping = quoteLines.reduce((total, line) => {
      if (line.status === "No Quote") return total;
      const lineQuantity = line.quantity ?? [];
      const prices = line.id != null ? (pricesByLine[line.id] ?? []) : [];
      const price = prices.find(
        (p: Database["public"]["Tables"]["quoteLinePrice"]["Row"]) =>
          p.quantity === lineQuantity[0]
      );
      return total + (price?.convertedShippingCost ?? 0);
    }, 0);
    const quoteShipping = (shipment?.shippingCost ?? 0) * (exchangeRate ?? 1);
    return lineShipping + quoteShipping;
  };

  const getTotalFees = () => {
    return quoteLines.reduce((total, line) => {
      if (line.status === "No Quote") return total;
      const additionalCharges = line.additionalCharges ?? {};
      const quantity = (line.quantity ?? [])[0];
      const charges = Object.values(additionalCharges).reduce((acc, charge) => {
        let amount = quantity != null ? (charge.amounts?.[quantity] ?? 0) : 0;
        if (shouldConvertCurrency) {
          amount *= exchangeRate;
        }
        return acc + amount;
      }, 0);
      return total + charges;
    }, 0);
  };

  const getTotalTaxes = () => {
    return quoteLines.reduce((total, line) => {
      if (line.status === "No Quote") return total;
      const lineQuantity = line.quantity ?? [];
      const prices = line.id != null ? (pricesByLine[line.id] ?? []) : [];
      const price = prices.find(
        (p: Database["public"]["Tables"]["quoteLinePrice"]["Row"]) =>
          p.quantity === lineQuantity[0]
      );
      const netExtendedPrice = price?.convertedNetExtendedPrice ?? 0;
      const additionalCharges = line.additionalCharges ?? {};
      const quantity = lineQuantity[0];
      const taxableFees = Object.values(additionalCharges).reduce(
        (acc, charge) => {
          if (charge.taxable === false) return acc;
          let amount = quantity != null ? (charge.amounts?.[quantity] ?? 0) : 0;
          if (shouldConvertCurrency) {
            amount *= exchangeRate;
          }
          return acc + amount;
        },
        0
      );
      const lineShipping = price?.convertedShippingCost ?? 0;
      const taxableAmount = netExtendedPrice + taxableFees + lineShipping;
      return total + taxableAmount * (line.taxPercent ?? 0);
    }, 0);
  };

  const getTotal = () =>
    getTotalSubtotal() + getTotalShipping() + getTotalFees() + getTotalTaxes();

  const maxLeadTime = getMaxLeadTime();
  const watermarkSrc = company.logoWatermark;

  let rowIndex = 0;

  return (
    <Template
      title={title}
      meta={{
        author: meta?.author ?? "Dhivio",
        keywords: meta?.keywords ?? "quote",
        subject: meta?.subject ?? "Quote"
      }}
      footerDocumentId={quote?.quoteId}
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
        title="Quote"
        documentId={quote?.quoteId}
        currencyCode={quote?.currencyCode}
        locale={locale}
      />

      {/* Body row — TO (customer left) | QUOTE DETAILS (right) */}
      <View style={tw("border border-gray-200 mb-4")}>
        <View style={tw("flex flex-row")}>
          {/* LEFT — Customer block (addressee) */}
          <View style={tw("w-1/2 p-3 border-r border-gray-200")}>
            <Text
              style={tw("text-[9px] font-bold text-gray-600 mb-1 uppercase")}
            >
              To
            </Text>
            <View style={tw("text-[9px] text-gray-800")}>
              <AddressBlock
                name={customerName}
                addressLine1={customerAddressLine1}
                addressLine2={customerAddressLine2}
                city={customerCity}
                stateProvince={customerStateProvince}
                postalCode={customerPostalCode}
                countryCode={customerCountryCode}
              />
              {customerTaxId && !isEoriCountry(customerCountryCode) && (
                <Text>Tax ID: {customerTaxId}</Text>
              )}
              {customerVatNumber && <Text>VAT: {customerVatNumber}</Text>}
              {customerEori && <Text>EORI: {customerEori}</Text>}
              {contactName && <Text>Contact: {contactName}</Text>}
              {contactEmail && <Text>Email: {contactEmail}</Text>}
            </View>
          </View>

          {/* RIGHT — Quote Details */}
          <View style={tw("w-1/2 p-3")}>
            <Text
              style={tw("text-[9px] font-bold text-gray-600 mb-1 uppercase")}
            >
              Quote Details
            </Text>
            <View style={tw("text-[9px] text-gray-800")}>
              <Text>
                Date:{" "}
                {formatDate(
                  today(getLocalTimeZone()).toString(),
                  undefined,
                  locale
                )}
              </Text>
              {quote.expirationDate && (
                <Text style={tw("font-bold")}>
                  Expires: {formatDate(quote.expirationDate, undefined, locale)}
                </Text>
              )}
              {quote.customerReference && (
                <Text>Reference: {quote.customerReference}</Text>
              )}
              {maxLeadTime > 0 && (
                <Text>
                  Max Lead Time: {maxLeadTime} {pluralize(maxLeadTime, "day")}
                </Text>
              )}
              {paymentTerm && <Text>Payment Terms: {paymentTerm.name}</Text>}
              {shipment?.incoterm && (
                <Text>
                  Incoterm: {shipment.incoterm}
                  {shipment.incotermLocation
                    ? ` — ${shipment.incotermLocation}`
                    : ""}
                </Text>
              )}
            </View>
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
            {Object.keys(quote?.externalNotes ?? {}).length > 0 ? (
              <Note content={(quote.externalNotes ?? {}) as JSONContent} />
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
            "flex flex-row bg-gray-800 py-2 px-3 text-white text-[9px] font-bold items-center"
          )}
        >
          <View style={tw("w-1/3")}>
            <Text>Description</Text>
          </View>
          <View style={tw("w-2/3 flex flex-row items-center")}>
            <Text style={tw(`${colWidth} text-center pr-3`)}>Qty</Text>
            <View style={tw(`${colWidth} items-center pr-3`)}>
              <Text>Unit Price</Text>
              <Text style={[tw("text-[7px] font-normal"), { opacity: 0.7 }]}>
                {currencyCode}
              </Text>
            </View>
            {!hasSinglePricePerLine && (
              <View style={tw(`${colWidth} items-center pr-3`)}>
                <Text>Tax & Fees</Text>
                <Text style={[tw("text-[7px] font-normal"), { opacity: 0.7 }]}>
                  {currencyCode}
                </Text>
              </View>
            )}
            {hasAnyLeadTime && (
              <Text style={tw(`${colWidth} text-center pr-3`)}>Lead Time</Text>
            )}
            <View style={tw(`${colWidth} items-center`)}>
              <Text>Total</Text>
              <Text style={[tw("text-[7px] font-normal"), { opacity: 0.7 }]}>
                {currencyCode}
              </Text>
            </View>
          </View>
        </View>

        {/* Rows */}
        {quoteLines.map((line) => {
          const unitPriceNumberFormatter = new Intl.NumberFormat(locale, {
            style: "decimal",
            minimumFractionDigits: line.unitPricePrecision ?? 2,
            maximumFractionDigits: line.unitPricePrecision ?? 2
          });

          const additionalCharges = line.additionalCharges ?? {};

          return (
            <View key={line.id} wrap={false}>
              {line.status !== "No Quote" ? (
                (line.quantity ?? []).map((quantity, index) => {
                  const prices =
                    line.id != null ? (pricesByLine[line.id] ?? []) : [];
                  const price = prices.find(
                    (
                      p: Database["public"]["Tables"]["quoteLinePrice"]["Row"]
                    ) => p.quantity === quantity
                  );
                  const unitPrice = price?.convertedUnitPrice ?? 0;
                  const netExtendedPrice =
                    price?.convertedNetExtendedPrice ?? 0;
                  const isEven = rowIndex % 2 === 0;
                  rowIndex++;

                  const leadTime = price?.leadTime ?? 0;

                  // Calculate tax & fees for this quantity
                  const additionalCharge = Object.values(
                    additionalCharges
                  ).reduce((acc, charge) => {
                    let amount = charge.amounts?.[quantity] ?? 0;
                    if (shouldConvertCurrency) {
                      amount *= exchangeRate;
                    }
                    return acc + amount;
                  }, 0);
                  const taxableAdditionalCharge = Object.values(
                    additionalCharges
                  ).reduce((acc, charge) => {
                    if (charge.taxable === false) return acc;
                    let amount = charge.amounts?.[quantity] ?? 0;
                    if (shouldConvertCurrency) {
                      amount *= exchangeRate;
                    }
                    return acc + amount;
                  }, 0);
                  const shippingCost = price?.convertedShippingCost ?? 0;
                  const taxPercent = line.taxPercent ?? 0;
                  const taxableBeforeTax =
                    netExtendedPrice + taxableAdditionalCharge + shippingCost;
                  const taxAmount = taxableBeforeTax * taxPercent;
                  const totalTaxAndFees =
                    additionalCharge + shippingCost + taxAmount;
                  const totalPrice = netExtendedPrice + totalTaxAndFees;

                  return (
                    <View
                      key={`${line.id}-${quantity}`}
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
                    >
                      <View style={tw("w-1/3 pr-2")}>
                        {index === 0 && (
                          <>
                            <Text style={tw("text-gray-800")}>
                              {getLineDescription(line)}
                            </Text>
                            <Text style={tw("text-[8px] text-gray-400 mt-0.5")}>
                              {getLineDescriptionDetails(line)}
                            </Text>
                            {thumbnails &&
                              line.id != null &&
                              line.id in thumbnails && (
                                <View style={tw("mt-2")}>
                                  <Image
                                    src={thumbnails[line.id]!}
                                    style={{ width: 60, height: 60 }}
                                  />
                                </View>
                              )}
                            {Object.keys(line.externalNotes ?? {}).length >
                              0 && (
                              <View style={tw("mt-1")}>
                                <Note
                                  key={`${line.id}-notes`}
                                  content={line.externalNotes as JSONContent}
                                />
                              </View>
                            )}
                            {totalTaxAndFees > 0 && (
                              <View style={tw("mt-1")}>
                                <Text
                                  style={tw(
                                    "text-[8px] text-gray-400 font-bold"
                                  )}
                                >
                                  Tax & Fees
                                </Text>
                                {(price?.convertedShippingCost ?? 0) > 0 && (
                                  <Text style={tw("text-[8px] text-gray-400")}>
                                    - Shipping
                                  </Text>
                                )}
                                {Object.values(additionalCharges)
                                  .filter(
                                    (charge) =>
                                      charge.description &&
                                      (charge.amounts?.[quantity] ?? 0) > 0
                                  )
                                  .sort((a, b) =>
                                    a.description.localeCompare(b.description)
                                  )
                                  .map((charge) => (
                                    <Text
                                      key={charge.description}
                                      style={tw("text-[8px] text-gray-400")}
                                    >
                                      - {charge.description}
                                    </Text>
                                  ))}
                                {taxPercent > 0 && (
                                  <Text style={tw("text-[8px] text-gray-400")}>
                                    - Tax ({(taxPercent * 100).toFixed(0)}%)
                                  </Text>
                                )}
                              </View>
                            )}
                          </>
                        )}
                      </View>
                      <View style={tw("w-2/3 flex flex-row")}>
                        <Text
                          style={tw(
                            `${colWidth} text-center text-gray-600 pr-3`
                          )}
                        >
                          {quantity} EA
                        </Text>
                        <Text
                          style={tw(
                            `${colWidth} text-center text-gray-600 pr-3`
                          )}
                        >
                          {unitPrice
                            ? unitPriceNumberFormatter.format(unitPrice)
                            : "-"}
                        </Text>
                        {!hasSinglePricePerLine && (
                          <Text
                            style={tw(
                              `${colWidth} text-center text-gray-600 pr-3`
                            )}
                          >
                            {totalTaxAndFees > 0
                              ? numberFormatter.format(totalTaxAndFees)
                              : "-"}
                          </Text>
                        )}
                        {hasAnyLeadTime && (
                          <Text
                            style={tw(
                              `${colWidth} text-center text-gray-600 pr-3`
                            )}
                          >
                            {leadTime > 0
                              ? `${leadTime} ${pluralize(leadTime, "day")}`
                              : "-"}
                          </Text>
                        )}
                        <Text
                          style={tw(
                            `${colWidth} text-center text-gray-800 font-medium`
                          )}
                        >
                          {hasSinglePricePerLine
                            ? netExtendedPrice > 0
                              ? numberFormatter.format(netExtendedPrice)
                              : "-"
                            : totalPrice > 0
                              ? numberFormatter.format(totalPrice)
                              : "-"}
                        </Text>
                      </View>
                    </View>
                  );
                })
              ) : (
                <View
                  style={[
                    tw(
                      "flex flex-row py-2 px-3 border-b border-gray-200 text-[10px]"
                    ),
                    {
                      backgroundColor:
                        rowIndex++ % 2 === 0
                          ? "transparent"
                          : "rgba(249, 250, 251, 0.6)"
                    }
                  ]}
                >
                  <View style={tw("w-1/3 pr-2")}>
                    <Text style={tw("text-gray-800")}>
                      {getLineDescription(line)}
                    </Text>
                    <Text style={tw("text-[8px] text-gray-400 mt-0.5")}>
                      {getLineDescriptionDetails(line)}
                    </Text>
                  </View>
                  <View style={tw("w-2/3 flex flex-row")}>
                    <Text
                      style={tw(
                        `${colWidth} text-right text-gray-600 font-bold`
                      )}
                    >
                      No Quote
                    </Text>
                    <View style={tw("flex-1 text-right")}>
                      <Text style={tw("text-gray-400 text-[8px] text-right")}>
                        {line.noQuoteReason ?? ""}
                      </Text>
                    </View>
                  </View>
                </View>
              )}
            </View>
          );
        })}

        {/* Summary - only show when single price per line */}
        {hasSinglePricePerLine && (
          <View>
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
                {numberFormatter.format(getTotalSubtotal())}
              </Text>
            </View>
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
                {numberFormatter.format(getTotalShipping())}
              </Text>
            </View>
            {getTotalFees() > 0 && (
              <View
                style={[
                  tw("flex flex-row py-1.5 px-3 text-[9px]"),
                  { backgroundColor: "rgba(249, 250, 251, 0.6)" }
                ]}
              >
                <Text style={tw("w-[80%] text-right pr-3 text-gray-600")}>
                  Fees ({currencyCode})
                </Text>
                <Text style={tw("w-[20%] text-right text-gray-800")}>
                  {numberFormatter.format(getTotalFees())}
                </Text>
              </View>
            )}
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
                {numberFormatter.format(getTotalTaxes())}
              </Text>
            </View>
            <View style={tw("h-[1px] bg-gray-200")} />
            <View style={tw("flex flex-row py-2 px-3 text-[9px]")}>
              <Text
                style={tw("w-[80%] text-right pr-3 text-gray-800 font-bold")}
              >
                Total
              </Text>
              <Text style={tw("w-[20%] text-right text-gray-800 font-bold")}>
                {currencyCode} {numberFormatter.format(getTotal())}
              </Text>
            </View>
          </View>
        )}
      </View>

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

export default QuotePDF;
