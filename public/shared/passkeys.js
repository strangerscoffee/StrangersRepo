// WebAuthn's native JSON helpers are newer than WebAuthn itself.
(() => {
  "use strict";
  const api = "/api/auth/passkeys";
  const $ = (id) => document.getElementById(id);
  const decode = (value) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  const encode = (value) => btoa(Array.from(new Uint8Array(value), (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const descriptors = (values) => values.map((item) => ({ ...item, id: decode(item.id) }));

  function supported(method) {
    return window.isSecureContext && typeof window.PublicKeyCredential === "function" &&
      typeof navigator.credentials?.[method] === "function";
  }

  function browserOptions(options, create) {
    const parse = create ? PublicKeyCredential.parseCreationOptionsFromJSON : PublicKeyCredential.parseRequestOptionsFromJSON;
    if (parse) return parse.call(PublicKeyCredential, options);
    const publicKey = { ...options, challenge: decode(options.challenge) };
    if (create) publicKey.user = { ...options.user, id: decode(options.user.id) };
    if (options.excludeCredentials) publicKey.excludeCredentials = descriptors(options.excludeCredentials);
    if (options.allowCredentials) publicKey.allowCredentials = descriptors(options.allowCredentials);
    return publicKey;
  }

  function serialize(credential, create) {
    if (typeof credential.toJSON === "function") return credential.toJSON();
    const { response } = credential;
    const data = { clientDataJSON: encode(response.clientDataJSON) };
    if (create) {
      data.attestationObject = encode(response.attestationObject);
      if (response.getTransports) data.transports = response.getTransports();
    } else {
      data.authenticatorData = encode(response.authenticatorData);
      data.signature = encode(response.signature);
      if (response.userHandle) data.userHandle = encode(response.userHandle);
    }
    return {
      id: credential.id, rawId: encode(credential.rawId), type: credential.type, response: data,
      authenticatorAttachment: credential.authenticatorAttachment,
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }

  async function useCredential(options, method, signal) {
    const create = method === "create";
    const credential = await navigator.credentials[method]({ publicKey: browserOptions(options, create), signal });
    if (!credential) throw new DOMException("", "NotAllowedError");
    return serialize(credential, create);
  }

  function message(error) {
    switch (error.name) {
      case "AbortError":
      case "NotAllowedError":
        return "The passkey prompt was cancelled, timed out, or couldn't find a passkey. You can try again.";
      case "InvalidStateError":
        return "This authenticator already has a passkey for your account.";
      case "NotSupportedError":
      case "SecurityError":
        return "Passkeys aren't available in this browser or on this address. You can still use your password.";
      default:
        return error.message || "The passkey request couldn't be completed. Try again.";
    }
  }

  async function request(path, { method = "GET", body } = {}) {
    const headers = new Headers();
    if (body) headers.set("content-type", "application/json");
    let response;
    try {
      response = await fetch(api + path, { method, headers, cache: "no-store", body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error("Couldn't reach the site. Check your connection.");
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.message || "The passkey request couldn't be completed. Try again.");
    return data;
  }

  async function setup({ user, passkeysAvailable }, next, pendingLogout) {
    const section = $("passkeys"), actions = $("passkeyActions"), error = $("passkeysError"), status = $("passkeysStatus");
    const addForm = $("passkeyAddForm"), removeForm = $("passkeyRemoveForm");
    const password = $("passkeyPassword"), name = $("passkeyName"), removePassword = $("passkeyRemovePassword");
    const list = $("passkeyList"), canCreate = supported("create");
    const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "Europe/London" });
    const controller = new AbortController();
    let passkeys = [], selected, ready = false;

    function wipePasswords() { password.value = removePassword.value = ""; }
    function shield() {
      section.hidden = true;
      wipePasswords();
    }
    function clear() {
      shield();
      controller.abort();
      ready = false;
      passkeys = [];
      selected = null;
      list.replaceChildren();
      name.value = $("passkeysAccount").textContent = $("passkeyRemoveName").textContent = "";
      error.textContent = status.textContent = "";
    }
    function restore() {
      // The shared session listener shields synchronously before these listeners run, and unlocks after proof.
      if (ready && !document.hidden && !pendingLogout()) section.hidden = false;
    }
    SC.recheckOnPageshow(() => location.reload());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) shield();
      else restore();
    });
    addEventListener("pagehide", shield);
    addEventListener("pageshow", (event) => { if (event.persisted) restore(); });
    if (!(await SC.bindSession(user, { clear }))) return;
    ready = true;
    $("passkeysAccount").textContent = `Signed in as ${user.name}`;
    $("passkeysBack").href = next;
    section.hidden = document.hidden;
    if (!section.hidden) $("passkeysTitle").focus();
    if (!passkeysAvailable) {
      error.textContent = "Passkeys are unavailable on this address.";
      return;
    }

    function currentAccountRequest(path, init) {
      if (pendingLogout()) throw new Error("Finish signing out before managing passkeys.");
      return request(path, init);
    }

    function select(passkey, trigger) {
      selected = passkey ? { passkey, trigger } : null;
      removePassword.value = "";
      $("passkeyRemoveName").textContent = selected ? `Remove “${passkey.name}” from your account?` : "";
      removeForm.hidden = !selected;
      addForm.hidden = !!selected || !canCreate;
      list.inert = !!selected;
      if (selected) {
        password.value = "";
        removePassword.focus();
      }
    }

    function renderList() {
      list.replaceChildren(...passkeys.map((passkey) => {
        const row = document.createElement("li"), info = document.createElement("div");
        const title = document.createElement("strong"), details = document.createElement("span");
        const remove = document.createElement("button");
        title.textContent = passkey.name;
        details.className = "note";
        details.textContent = `Added ${date.format(passkey.createdAt)} · ${passkey.lastUsedAt ? "Last used " + date.format(passkey.lastUsedAt) : "Never used"}`;
        info.append(title, details);
        remove.type = "button";
        remove.className = "linkbtn";
        remove.dataset.removePasskey = passkey.id;
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove passkey ${passkey.name}`);
        remove.addEventListener("click", () => {
          error.textContent = status.textContent = "";
          select(passkey, remove);
        });
        row.append(info, remove);
        return row;
      }));
      $("passkeyEmpty").hidden = passkeys.length > 0;
    }

    function submit(form, input, fn) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (form.inert) return;
        error.textContent = status.textContent = "";
        const enteredPassword = input.value;
        input.value = "";
        form.inert = list.inert = true;
        form.setAttribute("aria-busy", "true");
        status.textContent = "Please wait…";
        let complete = false;
        try {
          const update = await fn(enteredPassword);
          if (!ready) return;
          status.textContent = update;
          complete = true;
        } catch (failure) {
          if (ready) {
            status.textContent = "";
            error.textContent = message(failure);
          }
        } finally {
          form.removeAttribute("aria-busy");
          form.inert = false;
          list.inert = !!selected;
          if (ready && !section.hidden) {
            if (!complete || form === addForm) input.focus();
            else $("passkeysTitle").focus();
          }
        }
      });
    }

    submit(addForm, password, async (enteredPassword) => {
      const { challengeId, options } = await currentAccountRequest("/register/options", {
        method: "POST", body: { password: enteredPassword, name: name.value.trim() || undefined },
      });
      status.textContent = "Follow the passkey prompt on your device.";
      const credential = await useCredential(options, "create", controller.signal);
      if (controller.signal.aborted) throw new DOMException("", "AbortError");
      const { passkey } = await currentAccountRequest("/register/verify", {
        method: "POST", body: { challengeId, credential },
      });
      if (!ready) return;
      passkeys.unshift(passkey);
      renderList();
      name.value = "";
      return "Passkey added.";
    });
    $("passkeyRemoveCancel").addEventListener("click", () => {
      const { trigger } = selected;
      select(null);
      error.textContent = "";
      trigger.focus();
    });
    submit(removeForm, removePassword, async (enteredPassword) => {
      const { id } = selected.passkey;
      await currentAccountRequest("/" + encodeURIComponent(id), {
        method: "DELETE", body: { password: enteredPassword },
      });
      if (!ready) return;
      passkeys = passkeys.filter((passkey) => passkey.id !== id);
      select(null);
      renderList();
      return "Passkey removed.";
    });

    status.textContent = "Loading your passkeys…";
    currentAccountRequest("").then((data) => {
      if (!ready) return;
      passkeys = data.passkeys;
      renderList();
      actions.hidden = false;
      addForm.hidden = !canCreate;
      $("passkeyUnsupported").hidden = canCreate;
      status.textContent = "";
    }).catch((failure) => {
      if (!ready) return;
      status.textContent = "";
      error.textContent = message(failure);
    });
  }

  window.SCStaffPasskeys = { supported, useCredential, message, setup };
})();
