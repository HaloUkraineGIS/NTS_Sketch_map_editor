import OAuthInfo from '@arcgis/core/identity/OAuthInfo.js'
import esriId from '@arcgis/core/identity/IdentityManager.js'
import Portal from '@arcgis/core/portal/Portal.js'
import { OAUTH_CLIENT_ID, PORTAL_URL } from '../config'

const SESSION_CHECK_TIMEOUT_MS = 8000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Portal session check timed out')), timeoutMs)
    promise.then(resolve, reject).finally(() => window.clearTimeout(timer))
  })
}

const oauthInfo = new OAuthInfo({
  appId: OAUTH_CLIENT_ID,
  portalUrl: PORTAL_URL,
  flowType: 'auto',
  popup: false,
  preserveUrlHash: true,
})

let initialized = false

export function initializePortalAuth() {
  if (initialized) return
  esriId.registerOAuthInfos([oauthInfo])
  initialized = true
}

export async function getSignedInUser() {
  initializePortalAuth()
  try {
    await withTimeout(esriId.checkSignInStatus(`${PORTAL_URL}/sharing`), SESSION_CHECK_TIMEOUT_MS)
  } catch {
    return null
  }
  const portal = new Portal({ url: PORTAL_URL })
  await portal.load()
  return portal.user ?? null
}

export async function signInToPortal() {
  initializePortalAuth()
  await esriId.getCredential(`${PORTAL_URL}/sharing`, {
    oAuthPopupConfirmation: false,
  })
  return getSignedInUser()
}

export function signOutFromPortal() {
  esriId.destroyCredentials()
  window.location.assign(window.location.pathname)
}
