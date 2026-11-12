// Shared by the React host and the standalone viewer. IDs are persisted per browser.
export const WORLD_STYLES = /** @type {const} */ ([
  { id: "buildings", name: "Buildings", hint: "A city on floating islands", object: "Buildings", growth: "Lots become towers", color: "#ffb85c" },
  { id: "airplanes", name: "Airplanes", hint: "A hangar of gliders and airliners", object: "Aircraft", growth: "Gliders become airliners", color: "#a9c9f4" },
  { id: "galaxy", name: "Galaxy", hint: "Little solar systems in a sea of stars", object: "Planets", growth: "Planets gain rings and moons", color: "#b3a0ff" },
  { id: "forest", name: "Forest", hint: "Branching trees in woodland clearings", object: "Trees", growth: "Saplings grow broader canopies", color: "#83c997" },
  { id: "reef", name: "Ocean reef", hint: "Coral gardens beneath blue water", object: "Corals", growth: "Corals grow taller and branch", color: "#ff9dab" },
  { id: "mountains", name: "Mountains", hint: "Faceted peaks on contour terraces", object: "Peaks", growth: "Foothills become snowy peaks", color: "#b7d5df" },
  { id: "fleet", name: "Space fleet", hint: "Starships gathered in orbital formations", object: "Starships", growth: "Scouts become capital ships", color: "#8edcfa" },
  { id: "garden", name: "Garden", hint: "Leaves and blossoms in circular beds", object: "Plants", growth: "Seedlings become flowering plants", color: "#edb0db" },
  { id: "constellation", name: "Constellation", hint: "Stars joined into family constellations", object: "Stars", growth: "Stars gain rays and satellites", color: "#f5d48f" },
  { id: "mechanical", name: "Mechanical", hint: "Brass clockwork on dark turntables", object: "Mechanisms", growth: "Mechanisms gain wheels and gears", color: "#dfb779" },
  { id: "neural", name: "Neural network", hint: "Luminous nodes in a branching web", object: "Node clusters", growth: "Clusters gain nodes and branches", color: "#9ee3d2" },
  { id: "museum", name: "Museum", hint: "A sculpture collection in open galleries", object: "Sculptures", growth: "Exhibits become taller and layered", color: "#e6c8b0" },
]);
export const isWorldStyle = value => WORLD_STYLES.some(style => style.id === value);
export const worldStyleById = id => WORLD_STYLES.find(style => style.id === id) || WORLD_STYLES[0];
export const SPACE_STYLES = new Set(["galaxy", "fleet", "constellation", "neural"]);
