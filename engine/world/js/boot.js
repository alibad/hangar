import { embedded, tellHost } from "./host.js";

document.body.classList.toggle("hangar-embedded", embedded);
// Catch module/network failures too: those occur before main's boot handler.
import("./main.js").catch(error => {
  const message = String(error.message || error);
  tellHost("error", { message });
  const loading = document.getElementById("loading");
  loading.classList.add("error");
  loading.textContent = message;
  console.error(error);
});
