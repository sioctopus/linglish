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
- `sofa.jpg`: Wikimedia Commons File:19th century Victorian living room, Auckland - 0843.jpg
- `armchair.jpg`: Wikimedia Commons File:Armchair LACMA 50.28.11.jpg
- `coffee-table.jpg`: Wikimedia Commons File:Carleson Solid Wood Coffee Table In Provincial Tea (264060733).jpeg
- `bed.jpg`: Wikimedia Commons File:Bedroom (XIV. Century).jpg
- `curtain.jpg`: Wikimedia Commons File:90-year old Kate Carter in North Carolina log cabin.jpg
- `carpet.jpg`: Wikimedia Commons File:Carpet with geometric patterns on the floor in kindergarten. Buryatia, Russia.jpg
- `tile.jpg`: Wikimedia Commons File:Accessable toilet London Museum Docklands Canary Wharf London England.jpg
- `sink.jpg`: Wikimedia Commons File:2022-06-05 Wash basin in public toilet on ferry.jpg
- `toilet.jpg`: Wikimedia Commons File:EFTA00000172 - Luxurious bathroom with black marble walls a white toilet and a mirror illuminated by three lights.jpg
- `shower.jpg`: Wikimedia Commons File:After shower install.jpg
- `bathtub.jpg`: Wikimedia Commons File:A bathroom with a bathtub and shower in Mexico City.jpg
- `mirror.jpg`: Wikimedia Commons File:Bathroom in hotel in Bergen, Norway. 2016-03-16. Hand wash basin sink, mirror, toilet, etc. Also wall and floor tiles.jpg
- `razor.jpg`: Wikimedia Commons File:2023 Golarka Philips.jpg
- `toothpaste.jpg`: Wikimedia Commons File:Goupil Oil Colors��Large, Medium, and Double Tubes.png
- `toothbrush.jpg`: Wikimedia Commons File:Access toothbrush for use with Mini Dental Implants.jpg
- `soap.jpg`: Wikimedia Commons File:A bar of soap.jpg
- `shampoo.jpg`: Wikimedia Commons File:Care peach shampoo (2019) 02.jpg
- `broom.jpg`: Wikimedia Commons File:Cleaning Brush.jpg
- `mop.jpg`: Wikimedia Commons File:Cleaning supplies section in japanese hardware store.jpg
- `trash-can.jpg`: Wikimedia Commons File:Trash can and recycle bin.png
- `plant.jpg`: Wikimedia Commons File:Amaryllis (Hippeastrum) 18-01-2025. (actm.) 02.jpg
- `hanger.jpg`: Wikimedia Commons File:2020.05.30 Vintage Embroidered Hangers from Germany.jpg
- `remote.jpg`: Wikimedia Commons File:AverMedia RM-RH Remote control (white background) edit.jpg
- `faucet.jpg`: Wikimedia Commons File:American homes and gardens (1910) (18156119401).jpg
- `table.jpg`: Wikimedia Commons File:Dining table brown.jpg
- `wardrobe.jpg`: Wikimedia Commons File:Armoire Louvre OA 6968.jpg
- `bookshelf.jpg`: Wikimedia Commons File:Part of a bookshelf containing books by Aristotle (1).jpg
- `cushion.jpg`: Wikimedia Commons File:A Beagle lying on the sofa next to a colourful cushion.jpg
- `toilet-paper.jpg`: Wikimedia Commons File:Hotel Room Toilet Paper Roll Folded (42016671980).jpg
- `tissue.jpg`: Wikimedia Commons File:A tissue box.jpg
- `drawer.jpg`: Wikimedia Commons File:Chest-with-drawer MET 12022.jpg
- `dryer.jpg`: Wikimedia Commons File:Clothes dryer flex hose kinked.jpg
- `switch.jpg`: Wikimedia Commons File:Adelaide Exchange Buiilding Light Switch Detail IMG 20261009 172210242.jpg
- `socket.jpg`: Wikimedia Commons File:22 sockets grey-painted wall Three black electric power cables plugged in, school building in Lillesand, Norway. 22 stikkontkater p? gr?malt vegg med tre svarte str?mkabler (2024) IMG 8882.jpg
- `blender.jpg`: Wikimedia Commons File:Electrical blender juicer illustration - colored.png
- `coffee-maker.jpg`: Wikimedia Commons File:Braun Coffee Maker.jpg
- `balcony.jpg`: Wikimedia Commons File:Apartment balconies, Kanalv?gen and Floragatan, ?rebro.jpg
- `dining-room.jpg`: Wikimedia Commons File:Vihorlat Museum in Humenn�� - History and art history permanent exhibition - Kitchen and dining hall furniture exhibit room - Candlesticks on the wall behund dining table with porcelain tableware and chairs (September 2026) 02.jpg
- `laundry-basket.jpg`: Wikimedia Commons File:Clothes in green laundry basket.jpg
- `cutting-board.jpg`: Wikimedia Commons File:Kitchen renovation 9a cutting laminate board using circular saw and board guide.JPG
- `pan.jpg`: Wikimedia Commons File:Deep frying pan (8150591328).jpg
- `pillow.jpg`: Wikimedia Commons File:A pillow fight LCCN2012645701.tif
- `pot.jpg`: Wikimedia Commons File:Brass cooking pot (Himachal Pradesh),1.jpg
- `plate.jpg`: Wikimedia Commons File:A plate with crab substitute.jpg
- `bowl.jpg`: Wikimedia Commons File:Bowl with floret design and marks of a bureau of the Royal Kitchen, buncheong ware, Korea, Joseon dynasty, c. 1400-1500, stoneware - Asian Art Museum - San Francisco, CA - DSC07409.jpg
- `chopsticks.jpg`: Wikimedia Commons File:Bday sake set.jpg
- `spoon.jpg`: Wikimedia Commons File:Ekspozicio pri la Dua Mondmilito en la muzeo Urba Dumao (Tjumeno) 16.jpg
- `fork.jpg`: Wikimedia Commons File:Feldbesteck Bundeswehr TSR 81.jpg
- `knife.jpg`: Wikimedia Commons File:001 2011 09 28 Klingen.jpg
- `stove.jpg`: Wikimedia Commons File:Built-in Gas Stove at Bic Camera Namba.jpg
- `teacher.jpg`: Wikimedia Commons File:A public high school teacher in a classroom in the United States 02.jpg
- `professor.jpg`: Wikimedia Commons File:Matthew Kane Agarwala in the video 'SOAS Inaugural Lecture Series Professor Thomas Tanner and Professor Ulrich Volz'.png
- `doctor.jpg`: Wikimedia Commons File:Doctor smiles while entering a hospital room.jpg
- `nurse.jpg`: Wikimedia Commons File:(Civil War nurse partially identified as Miss Davis of South Street Hospital, Philadelphia, Pennsylvania, in traditional nurse's uniform) (LOC).jpg
- `dentist.jpg`: Wikimedia Commons File:A dental chair in a dentist clinic in North Carolina, United States.jpg
- `pharmacist.jpg`: Wikimedia Commons File:A couple and their child consulting a pharmacist in his shop Wellcome L0002913.jpg
- `chef.jpg`: Wikimedia Commons File:A skilled chef in gloves focuses on cooking at an outdoor gathering, surrounded by fresh ingredients and kitchen tools.jpg
- `waiter.jpg`: Wikimedia Commons File:A-waiter-serving-the-food-in-the-restaurant-142438919456.jpg
- `baker.jpg`: Wikimedia Commons File:A bread baker.jpg
- `barber.jpg`: Wikimedia Commons File:Barber at Work in Dubai.jpg
- `hairdresser.jpg`: Wikimedia Commons File:Dreamland Hair Salon, Toronto 2026.jpg
- `architect.jpg`: Wikimedia Commons File:A.V.Kozolov Blueprints.jpg
- `engineer.jpg`: Wikimedia Commons File:Exercise Cartwheel 2022 Engineer Project - Completion (7431481).jpg
- `software-engineer.jpg`: Wikimedia Commons File:ComputerProgrammer.jpg
- `network-engineer.jpg`: Wikimedia Commons File:Installation of the first summit network equipment May 2018 (rubin-2018-05-02-192510).jpg
- `civil-engineer.jpg`: Wikimedia Commons File:134 Civil Engineer Airmen Conduct Site Surveys in Korea (9741411).jpg
- `pilot.jpg`: Wikimedia Commons File:23 0067987 Convair Negative Image - Pilot in cockpit window of Convair 990 American Airlines 01-12-1962 (54182196992).jpg
- `driver.jpg`: Wikimedia Commons File:A bus driver.jpg
- `police-officer.jpg`: Wikimedia Commons File:Female Israeli Border Police officer chit-chats on the cell phone, old uniform type.jpg
- `firefighter.jpg`: Wikimedia Commons File:Air Force Fire Training.jpg
- `soldier.jpg`: Wikimedia Commons File:French soldier uniform WWI.jpg
- `farmer.jpg`: Wikimedia Commons File:A-farmer-is-busy-in-his-field-in-Algeria-142461617808.jpg
- `fisherman.jpg`: Wikimedia Commons File:Buiobuione Fisherman cleans the fish on a fishing boat at the Maafushi pier.jpg
- `postman.jpg`: Wikimedia Commons File:John H. Lowin, who delivers Drouin's mail, has a letter for Mrs Leslie Allison of Drouin, Victoria (6174070196).jpg
- `journalist.jpg`: Wikimedia Commons File:1+1-reporter-2008.jpg
- `lawyer.jpg`: Wikimedia Commons File:Cross-Examining T.R.From Telegraphic Description - DPLA - b1e71b3579080fc23bacfc42d527c0df.jpg
- `judge.jpg`: Wikimedia Commons File:7y3m67h9ae8g9pr5y5-5bre-11.jpg
- `cashier.jpg`: Wikimedia Commons File:Extra Coop supermarket, Bergen Storsenter, Norway 2017-11-01 cashier checkout a.jpg
- `cleaner.jpg`: Wikimedia Commons File:First-year nursing - a text-book for pupils during their first year of hospital work (1916) (14783289965).jpg
- `plumber.jpg`: Wikimedia Commons File:Barwick Patent Wrench and Pipe Tongs Morris Tasker and Co Illustrated Catalogue (1871).jpg
- `electrician.jpg`: Wikimedia Commons File:Electrician - Flickr - garryknight.jpg
- `mechanic.jpg`: Wikimedia Commons File:Auto Mechanic.jpg
- `carpenter.jpg`: Wikimedia Commons File:A Woodworker Whittling in Front of a Wood Stove.jpg
- `painter-job.jpg`: Wikimedia Commons File:'Written house (Schiller)' - gouache painting on paper - abstract art, made in 2007 by Dutch painter Fons Heijnsbroek.tif
- `photographer.jpg`: Wikimedia Commons File:Bird photographer in El Guenine dam (Tunisia).jpg
- `musician.jpg`: Wikimedia Commons File:A Ghanaian musician playing kolog instrument.jpg
- `singer.jpg`: Wikimedia Commons File:Lebanese singer Shiraz on Platea Stage of Juniyah.jpg
- `actor.jpg`: Wikimedia Commons File:Chaplin The Kid edit.jpg
- `dancer.jpg`: Wikimedia Commons File:ABT Swan Lake Curtain Call 2022 1.jpg
- `writer.jpg`: Wikimedia Commons File:A human writer and a creature with the head and wings of a crow, both sitting and typing on their own laptops, experiencing mild hallucinations (DALL-E illustration).webp
- `scientist.jpg`: Wikimedia Commons File:A scientist working in a laboratory.jpg
- `astronaut.jpg`: Wikimedia Commons File:Apollo 15 Astronaut David Scott's Actual NASA Space Suit In 'Smithsonian Air and Space Museum' (August 1st 2015).jpg
- `vet.jpg`: Wikimedia Commons File:ADT Hosts Animal Clinic DVIDS240132.jpg
- `librarian.jpg`: Wikimedia Commons File:(Librarians classifying books at the Library of Congress, Washington, D.C.) (LOC) - Flickr - The Library of Congress.jpg
- `coach.jpg`: Wikimedia Commons File:DF-SD-01-07095.jpg
- `family.jpg`: Wikimedia Commons File:Anthonie Palamedesz. - Group portrait of an unknown family in an interior.jpg
- `father.jpg`: Wikimedia Commons File:A Child Waiting for His Royal Marine Dad to Return from Afghanistan MOD 45158112.jpg
- `mother.jpg`: Wikimedia Commons File:Alexey Akindinov. Sketch for the painting Mom - portrait of mother - Ekaterina, 2000.jpg
- `dad.jpg`: Wikimedia Commons File:Dad with daughter at home.jpg
- `mom.jpg`: Wikimedia Commons File:Dandelions aren��t weeds- Airman��s first Mother��s Day without mom (3374670).jpg
- `grandfather.jpg`: Wikimedia Commons File:Three children and grandfather - C.M. Burd - 1921.jpg
- `grandmother.jpg`: Wikimedia Commons File:A woman and her grandson with a developmental disability.jpg
- `grandpa.jpg`: Wikimedia Commons File:Big and Small Age Grandpa and Grandson 01.jpg
- `grandma.jpg`: Wikimedia Commons File:Felix Schlesinger - Bei Gro?mutter.jpg
- `brother.jpg`: Wikimedia Commons File:Boys in China carry younger siblings (12464721993).jpg
- `sister.jpg`: Wikimedia Commons File:A child with her sister.jpg
- `older-brother.jpg`: Wikimedia Commons File:Brie Larson Captain Marvel Interview.jpg
- `older-sister.jpg`: Wikimedia Commons File:MediaWiki-tan.png
- `younger-brother.jpg`: Wikimedia Commons File:Boy and young girl on a porch - Oliver Optic's Annual Stories, Poems, and Pictures for Little Men and Women.jpg
- `younger-sister.jpg`: Wikimedia Commons File:A young boy helps his sister mother and the girl scouts plant trees.jpg
- `uncle.jpg`: Wikimedia Commons File:A Key to Uncle Tom's Cabin (1853).djvu
- `aunt.jpg`: Wikimedia Commons File:African American woman identified as "Aunt Fannie," servant of the Lott family) - Fredricks & O'Neil, Fifth Avenue Photograph Gallery, 179 Fifth Avenue, New York ; L.D. Fredricks ; John LCCN2017660617.jpg
- `cousin.jpg`: Wikimedia Commons File:Flower children; the little cousins of the field and garden.djvu
- `son.jpg`: Wikimedia Commons File:CHEZY QUEVANNE Portrait of a mother and her son, 1805.jpg
- `daughter.jpg`: Wikimedia Commons File:A President Trump supporter in Kenosha Wisconsin with daughter hoping to see Trump's motorcade.jpg
- `baby.jpg`: Wikimedia Commons File:Baby Face.JPG
- `husband.jpg`: Wikimedia Commons File:A day they become a Husband and Wife.jpg
- `wife.jpg`: Wikimedia Commons File:A woman is wearing a white wedding dress - DPLA - b6622cc0d69add3368ba40114a20e682 (page 1).jpg
- `parents.jpg`: Wikimedia Commons File:Inupiat Family from Noatak, Alaska, 1929, Edward S. Curtis (restored).jpg
- `grandparents.jpg`: Wikimedia Commons File:Grandparent enjoys coffee while watching child play with toy car during sunset at the park.jpg
- `nephew.jpg`: Wikimedia Commons File:Beatrice Webb and Boy, 1900 (7171336988).jpg
- `niece.jpg`: Wikimedia Commons File:(Helen Wright, age 12, niece of the Wright brothers, daughter of Reuchlin Wright) (LOC).jpg
- `relative.jpg`: Wikimedia Commons File:Baskerville and Goode family gathering - DPLA - 6122e552ae370a5874cce2c11531fece.jpg
- `twins.jpg`: Wikimedia Commons File:00000ECOLE SANGAREBOUGOU WIKI 2021 03.jpg
- `stepfather.jpg`: Wikimedia Commons File:Lloyd McAbee been doffing several months in the Spartan Mill, Spartenberg (sic), S.C. His step brother Walter Brown been working for one year. The parents said they couldn't find the family LOC nclc.02578.jpg
- `stepmother.jpg`: Wikimedia Commons File:Tales of Mother Goose (Welsh).djvu
