// Maps each tea's app id to its Shopify product variants: the size label, the
// variant GID (the only reliable join — variants have no SKUs), and the grams
// that size represents. Finished-goods stock is the per-variant bag count read
// from Shopify; grams are used to convert bags into mass for the forecast.
//
// Sizes:
//   Standard teas: 1oz (28g, from the shared "1 Oz Teas" product), 2oz (57g),
//                  4oz (113g), 8oz (227g).
//   Matcha-style (ceremonial/gingermatcha): 1oz (28g), 2oz (57g), 3.5oz (99g),
//                  all from their own product. Their entries in the shared
//                  "1 Oz Teas" product are intentionally NOT mapped (duplicates).
// Pulled from the connected Shopify store on 2026-06-13.

export type SizeVariant = { variantId: string; label: string; grams: number };

export const SHOPIFY_VARIANT_MAP: Record<string, SizeVariant[]> = {
  earlgrey: [
    { variantId: "gid://shopify/ProductVariant/10001", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10002", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10003", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10004", label: "8 oz", grams: 227 },
  ],
  breakfast: [
    { variantId: "gid://shopify/ProductVariant/10005", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10006", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10007", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10008", label: "8 oz", grams: 227 },
  ],
  oolong: [
    { variantId: "gid://shopify/ProductVariant/10009", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10010", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10011", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10012", label: "8 oz", grams: 227 },
  ],
  sencha: [
    { variantId: "gid://shopify/ProductVariant/10013", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10014", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10015", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10016", label: "8 oz", grams: 227 },
  ],
  jasmine: [
    { variantId: "gid://shopify/ProductVariant/10017", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10018", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10019", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10020", label: "8 oz", grams: 227 },
  ],
  ceremonial: [
    { variantId: "gid://shopify/ProductVariant/10021", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10022", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10023", label: "3.5 oz", grams: 99 },
  ],
  gingermatcha: [
    { variantId: "gid://shopify/ProductVariant/10024", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10025", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10026", label: "3.5 oz", grams: 99 },
  ],
  peony: [
    { variantId: "gid://shopify/ProductVariant/10027", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10028", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10029", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10030", label: "8 oz", grams: 227 },
  ],
  chamomile: [
    { variantId: "gid://shopify/ProductVariant/10031", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10032", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10033", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10034", label: "8 oz", grams: 227 },
  ],
  gingerdigest: [
    { variantId: "gid://shopify/ProductVariant/10035", label: "1 oz", grams: 28 },
    { variantId: "gid://shopify/ProductVariant/10036", label: "2 oz", grams: 57 },
    { variantId: "gid://shopify/ProductVariant/10037", label: "4 oz", grams: 113 },
    { variantId: "gid://shopify/ProductVariant/10038", label: "8 oz", grams: 227 },
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
