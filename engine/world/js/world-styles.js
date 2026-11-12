// Shared by the React host and the standalone viewer. IDs are persisted per browser.
export const WORLD_STYLES = /** @type {const} */ ([
  { id: "buildings", name: "Buildings", hint: "A city on floating islands", object: "Buildings", growth: "Lots become towers", color: "#ffb85c" },
  { id: "airplanes", name: "Airplanes", hint: "An airport with gates, taxiways and a runway", object: "Aircraft", growth: "Gliders become airliners", color: "#a9c9f4" },
  { id: "galaxy", name: "Galaxy", hint: "Planets across a continuous galactic field", object: "Planets", growth: "Planets gain rings and moons", color: "#b3a0ff" },
  { id: "forest", name: "Forest", hint: "Organic groves on a rolling landscape", object: "Trees", growth: "Saplings grow broader canopies", color: "#83c997" },
  { id: "reef", name: "Ocean reef", hint: "Coral across an uninterrupted sea floor", object: "Corals", growth: "Corals grow taller and branch", color: "#ff9dab" },
  { id: "mountains", name: "Mountains", hint: "Peaks along a continuous mountain range", object: "Peaks", growth: "Foothills become snowy peaks", color: "#b7d5df" },
  { id: "fleet", name: "Space fleet", hint: "Convoys and squadrons in open space", object: "Starships", growth: "Scouts become capital ships", color: "#8edcfa" },
  { id: "garden", name: "Garden", hint: "Flowering trails through a shared garden", object: "Plants", growth: "Seedlings become flowering plants", color: "#edb0db" },
  { id: "constellation", name: "Constellation", hint: "Luminous stars joined across a celestial field", object: "Stars", growth: "Larger projects shine more brightly", color: "#f5d48f" },
  { id: "mechanical", name: "Mechanical", hint: "Interconnected clockwork across a workshop", object: "Mechanisms", growth: "Mechanisms gain wheels and gears", color: "#dfb779" },
  { id: "neural", name: "Neural network", hint: "A spatial graph of categories and shared topics", object: "Node clusters", growth: "Larger projects become brighter nodes", color: "#9ee3d2" },
  { id: "museum", name: "Museum", hint: "Sculptures in connected architectural galleries", object: "Sculptures", growth: "Exhibits become taller and layered", color: "#e6c8b0" },
]);
export const isWorldStyle = value => WORLD_STYLES.some(style => style.id === value);
export const worldStyleById = id => WORLD_STYLES.find(style => style.id === id) || WORLD_STYLES[0];
export const SPACE_STYLES = new Set(["galaxy", "fleet", "constellation", "neural"]);
