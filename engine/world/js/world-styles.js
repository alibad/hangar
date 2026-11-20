// Shared by the React host and the standalone viewer. IDs are persisted per browser.
export const WORLD_STYLES = /** @type {const} */ ([
  { id: "buildings", name: "Buildings", hint: "A city on floating islands", object: "Buildings", growth: "Lots become towers", color: "#ffb85c" },
  { id: "airplanes", name: "Airplanes", hint: "An airport with gates, taxiways and a runway", object: "Aircraft", growth: "Gliders become airliners", color: "#a9c9f4" },
  { id: "galaxy", name: "Galaxy", hint: "Planets across a continuous galactic field", object: "Planets", growth: "Planets gain rings and moons", color: "#b3a0ff" },
  { id: "forest", name: "Forest", hint: "Pines, broadleaf trees and autumn groves", object: "Trees", growth: "Trees grow taller and broader", color: "#83c997" },
  { id: "reef", name: "Ocean reef", hint: "Branches, sea fans, plates and tubes", object: "Corals", growth: "Coral colonies grow taller and wider", color: "#ff9dab" },
  { id: "mountains", name: "Mountains", hint: "Sandstone mesas, green domes and snowy peaks", object: "Landforms", growth: "Larger projects form higher summits", color: "#b7d5df" },
  { id: "fleet", name: "Space fleet", hint: "Convoys and squadrons in open space", object: "Starships", growth: "Larger projects have longer hulls", color: "#8edcfa" },
  { id: "garden", name: "Garden", hint: "Flowering trails through a shared garden", object: "Plants", growth: "Seedlings become flowering plants", color: "#edb0db" },
  { id: "constellation", name: "Constellation", hint: "Luminous stars joined across a celestial field", object: "Stars", growth: "Larger projects appear as larger stars", color: "#f5d48f" },
  { id: "mechanical", name: "Mechanical", hint: "Interconnected clockwork across a workshop", object: "Mechanisms", growth: "Mechanisms gain wheels and gears", color: "#dfb779" },
  { id: "neural", name: "Neural network", hint: "A spatial graph of categories and shared topics", object: "Node clusters", growth: "Larger projects have larger node cores", color: "#9ee3d2" },
  { id: "museum", name: "Museum", hint: "Sculptures in connected architectural galleries", object: "Sculptures", growth: "Exhibits become taller and layered", color: "#e6c8b0" },
]);
export const isWorldStyle = value => WORLD_STYLES.some(style => style.id === value);
export const worldStyleById = id => WORLD_STYLES.find(style => style.id === id) || WORLD_STYLES[0];
export const SPACE_STYLES = new Set(["galaxy", "fleet", "constellation", "neural"]);
