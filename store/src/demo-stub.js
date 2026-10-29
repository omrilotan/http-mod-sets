// Stands in for the extension APIs so popup.html renders in a plain page for store screenshots.
(function initDemoStub() {
  const scene = new URLSearchParams(location.search).get("scene") || "list";

  const modSets = [
    {
      id: "staging",
      name: "Staging auth",
      enabled: true,
      match: { urlPattern: "api.acme.dev", methods: [], condition: null },
      mods: [
        { id: "s1", type: "addRequestHeader", headerName: "Authorization", headerValue: "Bearer dev-token" },
        { id: "s2", type: "addRequestHeader", headerName: "X-Feature-Flags", headerValue: "new-checkout" },
        { id: "s3", type: "modifyResponseHeader", headerName: "Cache-Control", from: "", to: "no-store", headerValue: "no-store" }
      ]
    },
    {
      id: "prices",
      name: "Mock prices",
      enabled: true,
      match: { urlPattern: "/\\/v2\\/prices/", methods: ["GET"], condition: null },
      mods: [
        { id: "p1", type: "editResponseBody", from: '"currency":"USD"', to: '"currency":"EUR"' },
        { id: "p2", type: "editResponseBody", from: '"price":(\\d+)', to: '"price":0', isRegex: true, regexFlags: "g" }
      ]
    },
    {
      id: "trackers",
      name: "Block trackers",
      enabled: true,
      match: { urlPattern: "/analytics|segment\\.io/i", methods: [], condition: null },
      mods: [{ id: "t1", type: "blockRequest" }]
    },
    {
      id: "cors",
      name: "CORS for local dev",
      enabled: false,
      match: { urlPattern: "localhost:3000", methods: ["GET", "POST"], condition: null },
      mods: [{ id: "c1", type: "addResponseHeader", headerName: "Access-Control-Allow-Origin", headerValue: "*" }]
    }
  ];

  const store = { modSets };
  const listeners = [];

  window.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: structuredClone(store[key]) };
        },
        async set(values) {
          Object.assign(store, structuredClone(values));
          listeners.forEach((fn) => fn({}, "local"));
        }
      },
      onChanged: {
        addListener(fn) {
          listeners.push(fn);
        }
      }
    },
    tabs: {
      async query() {
        return [{ id: 1, url: "https://api.acme.dev/checkout" }];
      },
      async sendMessage() {
        return {
          ok: true,
          urls: ["https://api.acme.dev/checkout", "https://api.acme.dev/v2/prices?sku=42", "https://cdn.segment.io/analytics.js"]
        };
      }
    }
  };

  try {
    localStorage.setItem("httpModSets.collapsed", JSON.stringify(scene === "list" ? ["cors"] : ["cors", "staging", "trackers"]));
  } catch (_err) {
    // Collapse state is cosmetic.
  }

  // Open an editor once the popup has rendered.
  window.addEventListener("load", () => {
    setTimeout(() => {
      if (scene === "edit") {
        document.querySelector('[data-mod-id="p2"] .mod-main').click();
      }
    }, 300);
  });
})();
