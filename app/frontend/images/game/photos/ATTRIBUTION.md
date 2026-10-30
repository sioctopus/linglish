# Game photo attribution

Real photos used by Linglish theme cards and challenge word packs.

| Source | License | Used for |
| --- | --- | --- |
| [ricoz/toddleranimals](https://github.com/ricoz/toddleranimals) | MIT | Animal photos (e.g. dog) |
| [hgzojer/picturetrainer](https://github.com/hgzojer/picturetrainer) | MIT / Wikimedia-sourced | Some fruit photos |
| [lightly-ai/dataset_clothing_images](https://github.com/lightly-ai/dataset_clothing_images) | CC0 | Clothing photos, including the hat and cap cards |
| [Unsplash](https://unsplash.com/license) | Unsplash License | Vehicles, scenes, nature landscapes, panda, penguin, kangaroo, polar bear |
| [Pexels](https://www.pexels.com/license/) | Pexels License | Volcano, grassland, jungle, sky, stars, snow mountain, open-water shark, and verified fruit, appliance, and body photos (1414115 lemon, 867349 kiwi, 2907428 dragon fruit, 327098 tangerine, 5945748 pomegranate, 322483 coconut, 1268122 apricot, 5945739 papaya, 1435734 grapefruit, 1414116 lime, 9444063 fig, 5097676 lychee, 12695566 durian, 5945659 plum, 9469639 cantaloupe, 8535657 playground, 27697206 boat, 37009064 bus, 1201996 television, 8032016 fridge, 28479466 washing machine, 16592625 air conditioner, 4102862 fan, 32168944 microwave, 11770362 rice cooker, 30319669 kettle, 1112598 lamp, 3747096 computer, 7703301 vacuum, 8082207 oven, 7936638 toaster, 3758494 hair dryer, 28576628 iron, 1279107 speaker, 4752984 heater, 34593293 water heater, 9551377 dishwasher, 774909 face, 1435739 eye, 3760852 hair, 4506105 neck) |
| Pixabay CDN | Pixabay Content License | Additional animal/fruit fills |
| Linglish generated swatches | — | Color cards (red/blue/…) |
| [Wikimedia Commons](https://commons.wikimedia.org/) | Public domain, CC0, or the note issuer's illustration terms | Currency cards: US $1/$5/$10/$100 (public domain), 10,000 yen (public domain), 10,000 won (Bank of Korea reproduction terms), 1946 Bank of Taiwan 100 yuan note, 2002 Hong Kong ten-dollar note (CC0), fifth-series renminbi 1/5/10/20/50/100 yuan cropped from [Banknotes YuanRPC.png](https://commons.wikimedia.org/wiki/File:Banknotes_YuanRPC.png) (CC0), 500,000 dong photograph |
| [Pexels](https://www.pexels.com/license/) | Pexels License | Currency cards: British £10 note (34002434), 100 euro note (4389245), Thai 20 baht note (29917029) |

Numbers (1–100) and letters (A–Z) are large glyphs on a transparent background. Drawn cards (body, appliances, shapes) keep the line art only: do not add a backdrop of any color, including white. Color swatches are the color itself and fill the whole picture.

To refresh or fill gaps:

```bash
cd app/backend
node scripts/fetch-game-photos.js
node scripts/wire-game-photos.js
```
## Vehicle photo repair (v=6)

- `police-car.jpg` ← police car ← Wikimedia Commons File:NYPD Ford Crown Victoria.jpg (CC BY-SA 2.0) ← https://images.pexels.com/photos/532001/pexels-photo-532001.jpeg?auto=compress&cs=tinysrgb&w=1280
- `fire-truck.jpg` ← fire truck ← Wikimedia Commons File:Fire engine.jpg (CC BY-SA 3.0) ← https://images.pexels.com/photos/280222/pexels-photo-280222.jpeg?auto=compress&cs=tinysrgb&w=1280
- `scooter.jpg` ← scooter ← Wikimedia Commons File:Kick scooter.jpg (CC BY-SA 3.0) ← https://images.pexels.com/photos/1102777/pexels-photo-1102777.jpeg?auto=compress&cs=tinysrgb&w=1280
- `tractor.jpg` ← tractor ← Wikimedia Commons File:Tractor.jpg (CC BY-SA 3.0) ← https://images.pexels.com/photos/2255935/pexels-photo-2255935.jpeg?auto=compress&cs=tinysrgb&w=1280
- `jeep.jpg` ← jeep ← Wikimedia Commons File:Jeep Wrangler.jpg (CC BY-SA 2.0) ← https://images.pexels.com/photos/116675/pexels-photo-116675.jpeg?auto=compress&cs=tinysrgb&w=1280
- `convertible.jpg` ← convertible ← Wikimedia Commons File:Convertible car.jpg (CC BY 2.0) ← https://images.pexels.com/photos/170811/pexels-photo-170811.jpeg?auto=compress&cs=tinysrgb&w=1280
- `canoe.jpg` ← canoe ← Wikimedia Commons File:Canoe.jpg (CC BY-SA 3.0) ← https://images.pexels.com/photos/2398220/pexels-photo-2398220.jpeg?auto=compress&cs=tinysrgb&w=1280
- `ferry.jpg` ← ferry ← Wikimedia Commons File:Ferry.jpg (CC BY-SA 3.0) ← https://images.pexels.com/photos/813011/pexels-photo-813011.jpeg?auto=compress&cs=tinysrgb&w=1280
- `skateboard.jpg` ← skateboard ← Wikimedia Commons File:Skateboard.jpg (CC BY-SA 3.0) ← https://images.pexels.com/photos/165236/pexels-photo-165236.jpeg?auto=compress&cs=tinysrgb&w=1280
- `roller-skates.jpg` ← roller skates ← Wikimedia Commons File:Roller skates.jpg (CC BY-SA 3.0) ← https://images.pexels.com/photos/3621104/pexels-photo-3621104.jpeg?auto=compress&cs=tinysrgb&w=1280
- `carriage.jpg` ← carriage ← Wikimedia Commons File:Horse-drawn carriage.jpg (CC BY-SA 3.0) ← https://images.pexels.com/photos/2886284/pexels-photo-2886284.jpeg?auto=compress&cs=tinysrgb&w=1280
- `cable-car.jpg` ← cable car ← Wikimedia Commons File:Cable car.jpg (CC BY-SA 3.0) ← https://images.pexels.com/photos/2901209/pexels-photo-2901209.jpeg?auto=compress&cs=tinysrgb&w=1280
- `taxi.jpg` ← taxi ← Wikimedia Commons File:New York taxi.jpg (CC BY-SA 2.0) ← https://images.pexels.com/photos/1424246/pexels-photo-1424246.jpeg?auto=compress&cs=tinysrgb&w=1280

## Vehicle photo repair leftovers (v=6)

- `ambulance.jpg` ← Pexels 5969995 ambulance
- `tram.jpg` ← Pexels 3573382 tram
- `yacht.jpg` ← Pexels 843633 yacht
- `hot-air-balloon.jpg` ← Pexels 1574843 hot air balloon

## Rocket Starship (v=6)

- ocket.jpg ← SpaceX Starship SN16 ← Wikimedia Commons File:Starship SN16 (51439054720).jpg (CC BY-SA 2.0)

## Vehicle Commons repair (v=7)

- `fire-truck.jpg` ← Wikimedia Commons File:Fire engine.jpg
- `hot-air-balloon.jpg` ← Wikimedia Commons File:Hot air balloon.jpg
- `roller-skates.jpg` ← Wikimedia Commons File:Roller skates.jpg
- `tractor.jpg` ← Wikimedia Commons File:John Deere 6620.jpg
- `jeep.jpg` ← Wikimedia Commons File:Jeep Wrangler.jpg
- `convertible.jpg` ← Wikimedia Commons File:Mazda MX-5.jpg
- `ferry.jpg` ← Wikimedia Commons File:Ferry.jpg
- `tram.jpg` ← Wikimedia Commons File:C Class Tram, Melbourne - Jan 2008.jpg
- `cable-car.jpg` ← Wikimedia Commons File:San Francisco cable car.jpg
- `police-car.jpg` ← Wikimedia Commons File:Swedish police car with lights on.jpg
- `scooter.jpg` ← Wikimedia Commons File:Gabriel riding a kick scooter... (Lisbon)
- `canoe.jpg` ← Wikimedia Commons File:Canoe.jpg
- `taxi.jpg` ← Wikimedia Commons File:Yellow taxi.jpg
