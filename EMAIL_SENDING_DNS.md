# Cloudflare Email Sending: mailguyai.com

mailguyai.com was onboarded to Cloudflare Email Service (Email Sending) by John on 2026-10-07,
so mail sent from an address on mailguyai.com can reach any recipient, not only addresses
verified in Email Routing. These are the records the onboarding showed, as John saved them.
Checked live with dig at 07:2x EDT the same day: all of the cf-bounce records and the DKIM key
below are published. The existing _dmarc.mailguyai.com record was kept (p=quarantine with
aggregate and forensic reports to dmarc-reports@mailguyai.com) rather than the wizard's
"v=DMARC1; p=reject;".

| Type | Hostname | Priority | Value |
|---|---|---|---|
| MX | cf-bounce.mailguyai.com | 59 | route1.mx.cloudflare.net. |
| MX | cf-bounce.mailguyai.com | 69 | route2.mx.cloudflare.net. |
| MX | cf-bounce.mailguyai.com | 17 | route3.mx.cloudflare.net. |
| TXT | cf-bounce.mailguyai.com | | "v=spf1 include:_spf.mx.cloudflare.net ~all" |
| TXT | cf-bounce._domainkey.mailguyai.com | | DKIM public key, below |
| TXT | _dmarc.mailguyai.com | | wizard proposed "v=DMARC1; p=reject;" (live record kept at p=quarantine) |

DKIM record value (a public key; safe to publish):

    "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiweykoi+o48IOGuP7GR3X0MOExCUDY/BCRHoWBnh3rChl7WhdyCxW3jgq1daEjPPqoi7sJvdg5hEQVsgVRQP4DcnQDVjGMbASQtrY4WmB1VebF+RPJB2ECPsEDTpeiI5ZyUAwJaVX7r6bznU67g7LvFq35yIo4sdlmtZGV+i0H4cpYH9+3JJ78km4KXwaf9xUJCWF6nxeD+qG6Fyruw1Qlbds2r85U9dkNDVAS3gioCvELryh1TxKGiVTkg4wqHTyHfWsp7KD3WQHYJn0RyfJJu6YEmL77zonn7p2SRMvTMP3ZEXibnC9gz3nnhR6wcYL8Q7zXypKTMD58bTixDSJwIDAQAB"

What this means for senders: the From address must be on mailguyai.com (the onboarded
domain). Other domains (authfor.com, weylandai.com) are not onboarded; mail "from" them is
limited to verified destinations until they are onboarded too.
