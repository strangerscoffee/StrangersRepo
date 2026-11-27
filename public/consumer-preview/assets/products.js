import { createAvailability } from './availability.js';
import { catalogueAdditions } from './products-additions.js';

const catalogue = [
  {
    "id": "christmas-blend",
    "name": "Christmas Blend",
    "notes": [
      "Cranberry",
      "Marmalade",
      "Liqueur Chocolate"
    ],
    "url": "https://strangerscoffee.com/coffee/p/christmas-blend",
    "shortCopy": "NEW: Cranberry / Marmalade / Liqueur Chocolate",
    "prices": {
      "250g": 1400,
      "500g": 2800,
      "1kg": 5000
    },
    "country": "Blend",
    "profile": "Fruity",
    "image": "/consumer-preview/assets/christmas-blend.webp",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ]
  },
  {
    "id": "boozy-santa-blend",
    "name": "Boozy Santa Blend",
    "notes": [
      "Christmas Pudding",
      "Brandy Sauce",
      "Christmas Spice"
    ],
    "url": "https://strangerscoffee.com/coffee/p/boozy-santa-blend",
    "shortCopy": "NEW: Christmas Pudding / Brandy Sauce / Christmas Spice",
    "prices": {
      "250g": 1400,
      "500g": 2800,
      "1kg": 5000
    },
    "country": "Blend",
    "profile": "Chocolatey",
    "image": "/consumer-preview/assets/boozy-santa-blend.webp",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ]
  },
  {
    "id": "cherry-bomb",
    "name": "Ethiopia Cherry Bomb",
    "country": "Ethiopia",
    "region": "Megadu, Guji",
    "process": "Natural - Anaerobic 96hr",
    "notes": [
      "Cherry Liqueur",
      "White Peach",
      "Guava"
    ],
    "profile": "Fruity",
    "image": "/consumer-preview/assets/cherry-bomb.webp",
    "story": "Lot K, Cherry Bomb, is produced by Bette Bunna in Megadu, Guji. The coffee is processed as a natural using a 96-hour anaerobic fermentation method.",
    "prices": {
      "250g": 1800,
      "500g": 3600,
      "1kg": 7000
    },
    "shortCopy": "NEW: Cherry Liqueur / White Peach / Guava",
    "url": "https://strangerscoffee.com/coffee/p/ethiopia-cherry-bomb",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ],
    "shelfOrder": 1
  },
  {
    "id": "bom-jesus",
    "name": "Brazil Fazenda Bom Jesus Natural",
    "country": "Brazil",
    "region": "Alta Mogiana Sao Paulo",
    "process": "Natural",
    "notes": [
      "Chocolate",
      "Hazelnut",
      "Praline"
    ],
    "profile": "Chocolatey",
    "image": "/consumer-preview/assets/bom-jesus.webp",
    "story": "Fazenda Bom Jesus, managed by Gabriel and Flavia Lancha Oliveira, carries a rich heritage in coffee cultivation.",
    "prices": {
      "250g": 1050,
      "500g": 2100,
      "1kg": 3700
    },
    "shortCopy": "Chocolate / Hazelnut / Praline",
    "url": "https://strangerscoffee.com/coffee/p/brazil-fazenda-bom-jesus-natural",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ],
    "shelfOrder": 0
  },
  {
    "id": "anserma",
    "name": "Colombia Anserma Natural",
    "country": "Colombia",
    "region": "Caldas",
    "process": "Natural",
    "notes": [
      "Black Forest Gateau",
      "Liqueur Chocolate",
      "Cherry"
    ],
    "profile": "Fruity",
    "image": "/consumer-preview/assets/anserma.webp",
    "story": "Anserma is located in the western area of the department of Caldas. It is an agricultural centre where the cultivation of coffee stands out.",
    "prices": {
      "250g": 1400,
      "500g": 2800,
      "1kg": 5000
    },
    "shortCopy": "Black Forest Gateau / Liqueur Chocolate / Cherry",
    "url": "https://strangerscoffee.com/coffee/p/colombia-anserma-natural",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ],
    "shelfOrder": 3
  },
  {
    "id": "ethiopia-idido-anaerobic-natural",
    "name": "Ethiopia Idido Anaerobic Natural",
    "notes": [
      "Mango",
      "Papaya",
      "Honeydew Melon"
    ],
    "url": "https://strangerscoffee.com/coffee/p/ethiopia-idido-anaerobic-natural",
    "shortCopy": "Mango / Papaya / Honeydew Melon",
    "prices": {
      "250g": 1600,
      "500g": 3200,
      "1kg": 6000
    },
    "country": "Ethiopia",
    "profile": "Fruity",
    "image": "/consumer-preview/assets/ethiopia-idido-anaerobic-natural.webp",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ]
  },
  {
    "id": "honduras-rosalina-ramos-natural",
    "name": "Honduras Rosalina Ramos Natural",
    "notes": [
      "Garibaldi Biscuit",
      "Hazelnut Praline",
      "Dried Fig"
    ],
    "url": "https://strangerscoffee.com/coffee/p/honduras-rosalina-ramos-natural",
    "shortCopy": "Garibaldi Biscuit / Hazelnut Praline / Dried Fig",
    "prices": {
      "250g": 1200,
      "500g": 2400,
      "1kg": 4400
    },
    "country": "Honduras",
    "profile": "Chocolatey",
    "image": "/consumer-preview/assets/honduras-rosalina-ramos-natural.webp",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ]
  },
  {
    "id": "rocko",
    "name": "Ethiopia Rocko Mountain Natural",
    "country": "Ethiopia",
    "region": "Gedeb woreda, south of Yirgacheffe",
    "process": "Natural",
    "notes": [
      "Blueberry",
      "Strawberry",
      "Chocolate"
    ],
    "profile": "Fruity",
    "image": "/consumer-preview/assets/rocko.webp",
    "story": "Tariku Mengesha, the sole owner of his farm in the Banko Chelchele kebele of Gedeb woreda, south of Yirgacheffe and near the Oromia region, produces exceptional natural coffee.",
    "prices": {
      "250g": 1200,
      "500g": 2400,
      "1kg": 4400
    },
    "shortCopy": "Blueberry / Strawberry / Chocolate",
    "url": "https://strangerscoffee.com/coffee/p/ethiopia-rocko-mountain-natural",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ],
    "shelfOrder": 4
  },
  {
    "id": "colombia-campo-santo-washed",
    "name": "Colombia Campo Santo Washed",
    "notes": [
      "Milk Chocolate",
      "Orange",
      "Caramel"
    ],
    "url": "https://strangerscoffee.com/coffee/p/colombia-campo-santo-washed",
    "shortCopy": "Milk Chocolate / Orange / Caramel",
    "prices": {
      "250g": 1050,
      "500g": 2100,
      "1kg": 3700
    },
    "country": "Colombia",
    "profile": "Chocolatey",
    "image": "/consumer-preview/assets/colombia-campo-santo-washed.webp",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ]
  },
  {
    "id": "decaf",
    "name": "Decaf Colombia San Lorenzo",
    "country": "Colombia",
    "region": "Caldas",
    "process": "Sugar Cane Decaf",
    "notes": [
      "Dark Chocolate",
      "Hazelnut",
      "Orange"
    ],
    "profile": "Decaf",
    "image": "/consumer-preview/assets/decaf.webp",
    "story": "Part of the Cooperativa de Caficultores de Alto Occidente de Caldas, established in 1964, the San Lorenzo indigenous group hails from the Rio Sucio municipality in Caldas.",
    "prices": {
      "250g": 1100,
      "500g": 2200,
      "1kg": 4000
    },
    "shortCopy": "Dark Chocolate / Hazelnut / Orange",
    "url": "https://strangerscoffee.com/coffee/p/decaf-colombia-san-lorenzo",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ],
    "shelfOrder": 2
  },
  {
    "id": "half-caff-blend",
    "name": "Half Caff Blend",
    "notes": [
      "Chocolate",
      "Hazelnut",
      "Orange"
    ],
    "url": "https://strangerscoffee.com/coffee/p/half-caff-blend",
    "shortCopy": "Chocolate / Hazelnut / Orange",
    "prices": {
      "250g": 1100,
      "500g": 2200,
      "1kg": 4000
    },
    "country": "Blend",
    "profile": "Chocolatey",
    "image": "/consumer-preview/assets/half-caff-blend.webp",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ]
  },
  {
    "id": "house-blend",
    "name": "House Blend",
    "notes": [
      "Brown Sugar",
      "Chocolate Digestive",
      "Clementine"
    ],
    "url": "https://strangerscoffee.com/coffee/p/house-blend",
    "shortCopy": "Brown Sugar / Chocolate Digestive / Clementine",
    "prices": {
      "250g": 1050,
      "500g": 2100,
      "1kg": 3700
    },
    "country": "Blend",
    "profile": "Chocolatey",
    "image": "/consumer-preview/assets/house-blend.webp",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ]
  },
  {
    "id": "fine-city-blend",
    "name": "Fine City Blend",
    "notes": [
      "Red Berries",
      "Chocolate",
      "Orange Citrus"
    ],
    "url": "https://strangerscoffee.com/coffee/p/fine-city-blend",
    "shortCopy": "Red Berries / Chocolate / Orange Citrus",
    "prices": {
      "250g": 1100,
      "500g": 2200,
      "1kg": 4000
    },
    "country": "Blend",
    "profile": "Fruity",
    "image": "/consumer-preview/assets/fine-city-blend.webp",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ]
  },
  {
    "id": "roasters-blend",
    "name": "Roasters Blend",
    "country": "Colombia",
    "region": "Tolima Colombia",
    "process": "Washed",
    "notes": [
      "Dark Chocolate",
      "Nutty",
      "Cinder Toffee"
    ],
    "profile": "Chocolatey",
    "image": "/consumer-preview/assets/roasters-blend.webp",
    "story": "An award winning coffee blend, designed with a more developed roast. Full bodied and rich with flavours of dark chocolate and caramel with a balanced rounded acidity.",
    "prices": {
      "250g": 1050,
      "500g": 2100,
      "1kg": 3700
    },
    "shortCopy": "Dark Chocolate / Nutty / Cinder Toffee",
    "url": "https://strangerscoffee.com/coffee/p/roasters-blend",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ],
    "shelfOrder": 5
  },
  {
    "id": "twin-peaks-blend",
    "name": "Twin Peaks Blend",
    "notes": [
      "Blueberry",
      "Strawberry",
      "Tangerine"
    ],
    "url": "https://strangerscoffee.com/coffee/p/twin-peaks-blend",
    "shortCopy": "Blueberry / Strawberry / Tangerine",
    "prices": {
      "250g": 1200,
      "500g": 2400,
      "1kg": 4400
    },
    "country": "Blend",
    "profile": "Fruity",
    "image": "/consumer-preview/assets/twin-peaks-blend.webp",
    "grinds": [
      "Whole bean",
      "Espresso / Fine",
      "Moka Pot / Fine",
      "Filter / Medium",
      "Cafetiere / Coarse"
    ]
  }
];
export const cafes = [
  {
    "id": "pottergate",
    "name": "Strangers Coffee House",
    "address": "21 Pottergate, Norwich, Norfolk NR2 1DS",
    "description": "Inside & outside seating available & takeaway",
    "image": "/consumer-preview/assets/pottergate.webp",
    "hours": [
      "Monday - Saturday 8.30am - 4.30pm",
      "Sunday 9am - 3pm"
    ],
    "map": "https://www.google.com/maps/dir/?api=1&destination=21+Pottergate%2C+Norwich+NR2+1DS"
  },
  {
    "id": "dove-street",
    "name": "Strangers Coffee Roasters",
    "address": "10 Dove Street, Norwich, Norfolk NR2 1DE",
    "description": "Open for takeaway",
    "image": "/consumer-preview/assets/dove-street.webp",
    "hours": [
      "Monday - Saturday 8.30am - 4.30pm",
      "Sunday 10.30am - 3.30pm"
    ],
    "map": "https://www.google.com/maps/dir/?api=1&destination=10+Dove+Street%2C+Norwich+NR2+1DE"
  },
  {
    "id": "all-saints-green",
    "name": "Strangers Coffee All Saints Green",
    "address": "14 All Saints Green, Norwich, Norfolk NR1 3NA",
    "description": "Open for takeaway",
    "image": "/consumer-preview/assets/all-saints-green.webp",
    "hours": [
      "Monday - Friday 8am - 4pm",
      "Saturday 8.30am - 4.30pm",
      "Sunday 10.30am - 3.30pm"
    ],
    "map": "https://www.google.com/maps/dir/?api=1&destination=14+All+Saints+Green%2C+Norwich+NR1+3NA"
  }
];

export const products = [...catalogue, ...catalogueAdditions];
export const availability = createAvailability(products);
