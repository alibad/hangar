// Sets day or night on the Path wrapper before it paints (render as the wrapper's first child).
// Plain module, so the server layout can read the string (a "use client" export would be a reference).
export const HQ_THEME_JS = `(function(){try{var r=document.currentScript&&document.currentScript.parentElement;if(!r)return;var t=null;try{t=localStorage.getItem("hq-theme")}catch(e){}if(t!=="night"&&t!=="day")t=matchMedia("(prefers-color-scheme: dark)").matches?"night":"day";r.setAttribute("data-hqp-theme",t)}catch(e){}})()`;
