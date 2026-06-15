// Maps each tea's app id to its Shopify product variants: the size label, the
// variant GID (the only reliable join — variants have no SKUs), and the grams
// that size represents. Finished-goods stock is the per-variant bag count read
// from Shopify; grams are used to convert bags into mass for the forecast.
//
// Sizes:
//   Standard teas: 1oz (28g, from the shared "1 Oz Teas" product), 2oz (57g),
//                  4oz (113g), 8oz (227g).
//   Matcha-style (matcha/chai/bluematcha): 1oz (28g), 2oz (57g), 3.5oz (99g),
//                  all from their own product. Their entries in the shared
//                  "1 Oz Teas" product are intentionally NOT mapped (duplicates).
// Pulled from the connected Shopify store on 2026-06-13.

export type SizeVariant = { variantId: string; label: string; grams: number };

export const SHOPIFY_VARIANT_MAP: Record<string, SizeVariant[]> = {
  mint: [
    { variantId: "gid://shopify/ProductVariant/10001", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10002", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10003", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10004", label: "8 oz", grams: 227 },
  ],
  darj: [
    { variantId: "gid://shopify/ProductVariant/10005", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10006", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10007", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10008", label: "8 oz", grams: 227 },
  ],
  tummy: [
    { variantId: "gid://shopify/ProductVariant/10009", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10010", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10011", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10012", label: "8 oz", grams: 227 },
  ],
  paradise: [
    { variantId: "gid://shopify/ProductVariant/10013", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10014", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10015", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10016", label: "8 oz", grams: 227 },
  ],
  mango: [
    { variantId: "gid://shopify/ProductVariant/10017", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10018", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10019", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10020", label: "8 oz", grams: 227 },
  ],
  lagoon: [
    { variantId: "gid://shopify/ProductVariant/10021", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10022", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10023", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10024", label: "8 oz", grams: 227 },
  ],
  keylime: [
    { variantId: "gid://shopify/ProductVariant/10025", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10026", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10027", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10028", label: "8 oz", grams: 227 },
  ],
  blackforest: [
    { variantId: "gid://shopify/ProductVariant/10029", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10030", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10031", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10032", label: "8 oz", grams: 227 },
  ],
  oolong: [
    { variantId: "gid://shopify/ProductVariant/10033", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10034", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10035", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10036", label: "8 oz", grams: 227 },
  ],
  radiant: [
    { variantId: "gid://shopify/ProductVariant/10037", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10038", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10039", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10040", label: "8 oz", grams: 227 },
  ],
  lavender: [
    { variantId: "gid://shopify/ProductVariant/10041", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10042", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10043", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10044", label: "8 oz", grams: 227 },
  ],
  cider: [
    { variantId: "gid://shopify/ProductVariant/10045", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10046", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10047", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10048", label: "8 oz", grams: 227 },
  ],
  mate: [
    { variantId: "gid://shopify/ProductVariant/10049", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10050", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10051", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10052", label: "8 oz", grams: 227 },
  ],
  cocoa: [
    { variantId: "gid://shopify/ProductVariant/10053", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10054", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10055", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10056", label: "8 oz", grams: 227 },
  ],
  rose: [
    { variantId: "gid://shopify/ProductVariant/10057", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10058", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10059", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10060", label: "8 oz", grams: 227 },
  ],
  rosebud: [
    { variantId: "gid://shopify/ProductVariant/10061", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10062", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10063", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10064", label: "8 oz", grams: 227 },
  ],
  matcha: [
    { variantId: "gid://shopify/ProductVariant/10065", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10066", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10067", label: "3.5 oz", grams: 99 },
  ],
  chai: [
    { variantId: "gid://shopify/ProductVariant/10068", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10069", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10070", label: "3.5 oz", grams: 99 },
  ],
  bluematcha: [
    { variantId: "gid://shopify/ProductVariant/10071", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10072", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10073", label: "3.5 oz", grams: 99 },
  ],
};

// Demo Tea Co. has two locations: the warehouse (own inventory, online + POS)
// and the Mall Store (consigned stock, tracked here for forecasting only —
// the Mall reconciles its own counts via its own WMS/POS).
export const SHOPIFY_LOCATIONS = {
  warehouse: { id: "gid://shopify/Location/900001", label: "Main Warehouse" },
  mall: { id: "gid://shopify/Location/900002", label: "Mall Store" },
} as const;

export type LocationKey = keyof typeof SHOPIFY_LOCATIONS;
