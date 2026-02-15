import fetch from 'node-fetch';
import { URL } from 'url';

export async function negotiateSignalRConnection() {
    const firstNegotiateUrl = "https://play.panquiz.com/api/v1/playHub/negotiate?negotiateVersion=1";
    const headers = {
        "Content-Type": "text/plain;charset=UTF-8",
        "Accept": "*/*",
        "Origin": "https://play.panquiz.com",
        "Referer": "https://play.panquiz.com/",
        "User-Agent": "Mozilla/5.0",
        "X-Requested-With": "XMLHttpRequest",
        "x-signalr-user-agent": "Microsoft SignalR/6.0 (6.0.7; Unknown OS; Browser; Unknown Runtime Version)"
    };

    try {
        const firstResponse = await fetch(firstNegotiateUrl, { method: 'POST', headers });
        const firstData = await firstResponse.json();

        const accessToken = firstData.accessToken;
        const websocketUrl = firstData.url;

        if (!accessToken || !websocketUrl) {
            return null;
        }

        const urlObj = new URL(websocketUrl);
        const asrsRequestId = urlObj.searchParams.get("asrs_request_id");

        const secondNegotiateUrl = `${urlObj.origin}/client/negotiate?hub=playhub&asrs.op=%2Fv1%2FplayHub&negotiateVersion=1&asrs_request_id=${asrsRequestId}`;
        headers.Authorization = `Bearer ${accessToken}`;

        const secondResponse = await fetch(secondNegotiateUrl, { method: 'POST', headers });
        const secondData = await secondResponse.json();

        const connectionToken = secondData.connectionToken;
        const connectionId = secondData.connectionId;

        if (!connectionToken || !connectionId) {
            return null;
        }

        const finalWebSocketUrl = `${websocketUrl}&id=${connectionToken}&access_token=${encodeURIComponent(accessToken)}`;
        return {
            websocketUrl: finalWebSocketUrl,
            accessToken,
            connectionId,
            connectionToken
        };
    } catch (error) {
        return null;
    }
}