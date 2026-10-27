import { expect, test } from "bun:test"
import { renderToString } from "solid-js/web"
import { FormAssessment } from "./form-request"

const nativeSource = {
  kind: "dots-native", profile: "profile_fixture", credentialID: "credential_fixture", accountID: "account_fixture",
  accountGeneration: 1, environmentID: "environment_fixture", connectionID: "connection_fixture", clientID: "client_fixture",
  streamID: "stream_fixture", rootSessionID: "ses_root", accessRevision: 2, requestID: "request_fixture",
}

test("native Dots Form attribution identifies the native source without exposing connection or credential identity", () => {
  const html = renderToString(() => <FormAssessment value={undefined} settled="client" source={nativeSource} />)
  expect(html).toContain("answered via native Dots · root ses_root")
  expect(html).not.toContain("coordinator")
  for (const value of Object.values(nativeSource).filter((value) => typeof value === "string" && value !== "dots-native" && value !== "ses_root")) expect(html).not.toContain(value)
})

test("Form attribution preserves coordinator and historical delegated sources", () => {
  const coordinator = renderToString(() => <FormAssessment value={undefined} settled="automatic" source={{ kind: "coordinator", coordinatorSessionID: "ses_coordinator", via: "auto-answer" }} />)
  expect(coordinator).toContain("answered by coordinator ses_coordinator via Answers Auto")
  const delegated = renderToString(() => <FormAssessment value={undefined} settled="client" source={{ kind: "dots-delegation", anchorSessionID: "ses_anchor", delegationID: "delegation_history", revision: 1, exchangeID: "exchange_history" }} />)
  expect(delegated).toContain("answered by external client via Dots delegation delegation_history")
  expect(delegated).toContain("anchor ses_anchor")
  const client = renderToString(() => <FormAssessment value={undefined} settled="client" source={{ kind: "dots-client", anchorSessionID: "ses_anchor", bindingID: "binding_history", delegationID: "delegation_client", revision: 1, exchangeID: "exchange_history", principal: { ownerID: "owner_history", deviceID: "device_history", clientID: "client_history", grantID: "grant_history", epoch: "epoch_history" } }} />)
  expect(client).toContain("answered by external client via Dots delegation delegation_client")
  expect(client).toContain("anchor ses_anchor")
  for (const identity of ["binding_history", "owner_history", "device_history", "client_history", "grant_history", "epoch_history"]) expect(client).not.toContain(identity)
})
