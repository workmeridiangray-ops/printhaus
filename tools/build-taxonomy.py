#!/usr/bin/env python3
"""Generate public/taxonomy.json — the 3-level category tree for the storefront.

The catalogue only has two levels (cat, subcat), and the subcats mix product
types ("Boxes"), industries ("Candle") and merchandising flags ("Ready to Buy").
This script places every product in a tidy Category > Subcategory > Group tree:

  L1  the catalogue `cat` (shown with a friendlier label)
  L2  product type, plus one "Shop by industry & use" bucket per category
  L3  a group inside L2 (only where an L2 has enough products to need one)

Edit the rules below (or taxonomy.json directly) to change the tree, then run:

    python3 tools/build-taxonomy.py public/calc-data.json public/taxonomy.json

Products that are not in taxonomy.json (e.g. created later in the admin) fall
back to [subcat, null] in the storefront, so nothing ever disappears.
"""
import collections
import json
import sys

L1 = [  # (catalogue cat, display label) in nav order
    ("Sticker/Labels", "Stickers & Labels"),
    ("Packaging", "Packaging"),
    ("Cards/Stationery", "Cards & Stationery"),
    ("Marketing", "Marketing"),
    ("Book Print On Demand", "Book Printing"),
    ("Document Printing", "Document Printing"),
    ("A0 Plan Printing", "A0 Plan Printing"),
    ("B2B Pricing", "B2B & Bulk"),
    ("Industry", "Industry"),
]

IND = "Shop by industry & use"
INDUSTRY = {  # subcat -> L3 label under IND
    "Candle": "Candle",
    "Garment & Fashion": "Garment & Fashion",
    "Health & Beauty": "Health & Beauty",
    "Packed Food & Beverage": "Packed Food & Beverage",
    "Restaurant, Bakery, Kitchen & Cafe": "Restaurant, Bakery & Cafe",
    "Perfume, Attar & Oils": "Perfume, Attar & Oils",
    "Cars, Bikes & Automobiles": "Cars, Bikes & Automobiles",
    "Giveaway, Events & Branding": "Giveaways & Events",
}

# (cat, subcat) -> L2 label, for subcats that are kept (or merged) as product types
L2_RENAME = {
    ("Sticker/Labels", "Bulk"): "Bulk stickers",
    ("Sticker/Labels", "Signs & Display"): "Signs & display",
    ("Sticker/Labels", "Ready to Buy"): "Ready to buy (unprinted)",
    ("Sticker/Labels", "New Arrivals"): "New arrivals",
    ("Packaging", "Ready to Buy"): "Ready to buy (unprinted)",
    ("Industry", "Ready to Buy"): "Ready to buy (unprinted)",
    ("B2B Pricing", "Bulk"): "Bulk orders",
    ("Cards/Stationery", "Business Cards"): "Business & visiting cards",
    ("Cards/Stationery", "Visiting Cards"): "Business & visiting cards",
    ("Cards/Stationery", "Card Envelopes"): "Envelopes",
    ("Cards/Stationery", "Envelopes"): "Envelopes",
    ("Marketing", "Accessories"): "Promo items & accessories",
    ("Marketing", "Custom Printed Round Badge"): "Promo items & accessories",
    ("Marketing", "Flash Cards"): "Promo items & accessories",
    ("Marketing", "Brochures"): "Brochures & flyers",
    ("Marketing", "Brochures & Company Flyers"): "Brochures & flyers",
    ("Marketing", "Company Brochures"): "Brochures & flyers",
    ("Marketing", "Leaflet"): "Brochures & flyers",
    ("Marketing", "Posters"): "Posters & danglers",
    ("Marketing", "Wall Danglers"): "Posters & danglers",
    ("Marketing", "Wall Posters"): "Posters & danglers",
    ("Marketing", "Signs & Display"): "Signs & banners",
}

# (cat, L2 label) -> ordered [(L3 label, [product-name prefixes])]
L3_RULES = {
    ("Sticker/Labels", "Stickers by Material"): [
        ("Vinyl & film", ["Premium Vinyl", "Standard (Economical)", "Thin Film", "Transparent Stickers", "White-Ink Clear", "Silver & Gold Vinyl"]),
        ("Paper & textured", ["Kraft Paper Stickers", "Textured Labels"]),
        ("Special effects", ["Holographic", "Foil Stickers", "Glow in the Dark", "3D Dome", "3D Raised", "Retro Reflective", "Metal Stickers", "Void (Tamper Proof)"]),
        ("Transfers, magnets & industrial", ["DTF Transfer", "Ink Transfer", "Custom Shape Magnets", "Front Adhesive", "Industrial Hi-adhesive"]),
    ],
    ("Sticker/Labels", "Stickers by Shape"): [
        ("Round & oval", ["Custom Round Sticker", "Oval Stickers"]),
        ("Square & rectangle", ["Square & Rectangle", "Round Edge Square/Rectangle"]),
        ("Special shapes", ["Arch Shape", "Heart Shape", "Scallop", "Starburst", "Custom Shape Stickers", "Edge Seal"]),
    ],
    ("Sticker/Labels", "Stickers by Use"): [
        ("Product labels", ["Product Labels", "Bottle & Jar", "Health & Beauty Labels", "Size & Price"]),
        ("Address, warning & warranty", ["Address Labels", "Warning Labels", "Warranty Labels", "One Time Use", "Machine Sticker"]),
        ("Walls, windows & gadgets", ["Wall Stickers", "Window / Glass", "Gadget Stickers"]),
    ],
    ("Packaging", "Boxes"): [
        ("Mailer boxes", ["Corrugated Mailer Box", "Full Print Corrugated Mailer Box"]),
        ("Product & gift boxes", ["Custom Paper Boxes", "Kraft Paper Product Box", "Tuck Top Box", "Custom Collapsible Rigid Box", "Box with Handle", "Popcorn Box"]),
        ("Cosmetic, perfume & pharma boxes", ["Custom Cosmetic Boxes", "Custom Medicine", "Custom Perfume", "Custom Agarbatti"]),
    ],
    ("Packaging", "Ready to buy (unprinted)"): [
        ("Bags & pouches", ["Black Courier Poly Bags", "Courier Poly Bags - POD", "Draw String Bags", "Frosted Zipper Bags", "Silver Bubble Poly Bags", "Stand Up Zip Pouch"]),
        ("Boxes & mailers", ["Corrugated Mailer Box", "Kraft Paper Mailer Envelopes", "White Bubble Envelope"]),
    ],
    ("Cards/Stationery", "Business & visiting cards"): [
        ("Standard & laminated", ["Standard Business Cards", "Gloss Laminated", "Velvet Touch", "Visiting Cards"]),
        ("Premium finishes", ["Raised Foil", "Raised Spot-UV"]),
        ("Specialty materials", ["Kraft Business Cards", "Magnetic", "Non Tear"]),
    ],
    ("Marketing", "Promo items & accessories"): [
        ("Badges & keychains", ["Button Badges", "Custom Printed Round Badge", "Custom Logo Keychains", "Premium Luggage Tags"]),
        ("Desk & stationery", ["Custom Bookmarks", "Custom Desk Organiser", "Certificates", "Gift Voucher", "Luxury Promo Cards", "Custom Shape Flash Cards"]),
        ("Hangers & displays", ["Door Hangers", "Tent Cards"]),
    ],
}


def place(cat, subcat, name):
    if subcat in INDUSTRY:
        return IND, INDUSTRY[subcat]
    l2 = L2_RENAME.get((cat, subcat), subcat)
    rules = L3_RULES.get((cat, l2))
    if not rules:
        return l2, None
    for l3, prefixes in rules:
        if any(name.startswith(p) for p in prefixes):
            return l2, l3
    print(f"WARN no L3 rule matched: {cat} > {l2} > {name!r}", file=sys.stderr)
    return l2, "Other"


def main(src, dst):
    data = json.load(open(src))
    mapping, tree = {}, collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    for slug, p in data.items():
        l2, l3 = place(p["cat"], p.get("subcat", ""), p["name"])
        mapping[slug] = [l2, l3]
        tree[p["cat"]][l2][l3] += 1
    out = {
        "version": 1,
        "l1": [{"key": k, "label": lbl} for k, lbl in L1 if k in tree],
        "map": mapping,
    }
    with open(dst, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    for k, lbl in L1:
        if k not in tree:
            continue
        print(f"{lbl} ({sum(sum(c.values()) for c in tree[k].values())})")
        for l2, c in sorted(tree[k].items(), key=lambda kv: (kv[0] == IND, -sum(kv[1].values()))):
            print(f"  {l2} ({sum(c.values())})")
            for l3, n in c.items():
                if l3:
                    print(f"      {l3} ({n})")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
