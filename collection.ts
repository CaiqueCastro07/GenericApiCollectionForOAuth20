import axios, { AxiosInstance } from "axios";
import * as moment from "moment"
import * as nodeCron from "node-cron"

function randomNumber(min: number, max: number): number { // min and max included 
    if ([min, max].some((e) => !Number(e) || e < 1)) return 0
    return Math.floor(Math.random() * (max - min + 1) + min)
}

const delay = async (time = 1000) => new Promise((resolve) => setTimeout(resolve, time))

const isObject = (obj: any): boolean => {

    if (!obj || typeof obj != 'object' || Array.isArray(obj) || !(obj instanceof Object)) return false

    return true

}

type ReturnStruct<T> = [Error, null] | [null, T];

class ServiceXApiCollection {
    private static CONFIG: "prod" | "stag" | "dev" = "dev"
    private static RECORDS_CACHING: Record<string, any> = {}
    private static modules_to_cache: any[] = []
    private static limpezaCache = nodeCron.schedule("*/30 * * * *", function () {
        Object.values(ServiceXApiCollection.RECORDS_CACHING).forEach((e) => {

            if (!structuredClone(e)) return

            Object.keys(e).filter((e1) => e1 != "reseting").forEach((e1) => {
                delete e[e1]
            })
        })
    });

    static accessTokenQuantity = ServiceXApiCollection.CONFIG == "prod" ? 4 : 1 // in the local/test environment will only create one access token, on prod will create 5 - the limit is 10
    private static readonly LOCAL_ACCESS_TOKENS: string[] = [];
    private static BASE_URL: string = null;
    private static CLIENT_ID: string = null;
    private static CLIENT_SECRET: string = null;
    private static REFRESH_TOKEN: string = null;
    private static TEST_REFRESH_TOKEN: string = null;
    private static accessTokenRenewing: boolean = false
    private static ACCESS_TOKENS_QUANTITY = 5

    private readonly getRecordCache = (idRecord: string, moduleName: any): any | null => {
        if (!idRecord || typeof idRecord != 'string') return null;
        if (!moduleName || typeof moduleName != 'string') return null;
        const record = ServiceXApiCollection.RECORDS_CACHING?.[moduleName]?.[idRecord];
        return record?.id ? structuredClone(record) : null
    }
    private readonly setRecordCache = (record: any, moduleName: any): boolean => {

        if (ServiceXApiCollection.RECORDS_CACHING?.[moduleName]?.reseting) return false
        if (!moduleName || typeof moduleName != 'string') return false
        if (!structuredClone(record) || !record?.id) return false

        const cachingDoModulo = ServiceXApiCollection.RECORDS_CACHING[moduleName]

        if (!structuredClone(cachingDoModulo)) {
            ServiceXApiCollection.RECORDS_CACHING[moduleName] = { [record.id]: structuredClone(record) }
        } else {
            cachingDoModulo[record.id] = structuredClone(record)
        }

        return true

    }

    #api: AxiosInstance = null

    static readonly #giroAccessToken = (): string => {

        const ref = ServiceXApiCollection.LOCAL_ACCESS_TOKENS

        const firstToken = ref.shift()

        if (!firstToken || typeof firstToken != 'string') return ""

        ref.push(firstToken)

        return firstToken

    }

    readonly #updateApiInstance: () => void

    static readonly setConfigsOnce = (vars: {
        baseUrl: string, client_id: string, client_secret: string, refresh_token: string,
        test_refresh_token?: string, accessTokensQuantity: number, cache_timeout_seconds: number,
        environment: "prod" | "stag" | "dev"
    }): "loaded" | "error" | "conflict" => {

        if (ServiceXApiCollection.BASE_URL) return "conflict" // bloqueia rodar novamente o setConfigs

        const { baseUrl, client_id, client_secret, refresh_token, test_refresh_token,
            accessTokensQuantity, cache_timeout_seconds, environment } = vars || {}

        if (![baseUrl, client_id, client_secret, refresh_token].every((e) => !e || typeof e != 'string')) return "error"

        ServiceXApiCollection.BASE_URL = baseUrl
        ServiceXApiCollection.CLIENT_ID = client_id
        ServiceXApiCollection.CLIENT_SECRET = client_secret
        ServiceXApiCollection.REFRESH_TOKEN = refresh_token

        if (environment && typeof environment == 'string') ServiceXApiCollection.CONFIG = environment;
        if (test_refresh_token && typeof test_refresh_token == 'string') ServiceXApiCollection.TEST_REFRESH_TOKEN = test_refresh_token
        if (Number(accessTokensQuantity) && Number(accessTokensQuantity) > 0) ServiceXApiCollection.ACCESS_TOKENS_QUANTITY = Number(accessTokensQuantity);
        // if(Number(cache_timeout_seconds) && Number(cache_timeout_seconds) > 0) ServiceXApiCollection
        // destruir funcao dps
        return "loaded"

    }

    constructor() {

        this.#updateApiInstance = () => {

            this.#api = axios.create({
                baseURL: ServiceXApiCollection.BASE_URL,
                headers: {
                    Authorization: `Bearer ${ServiceXApiCollection.#giroAccessToken()}`,
                    Accept: "*/*",
                    "Accept-Encoding": 'application/json'
                },
                timeout: 20000
            });

        }

        this.#updateApiInstance()

    }

    private async renewAccessToken(): Promise<ReturnStruct<null>> {

        if (!ServiceXApiCollection.accessTokenRenewing) {

            ServiceXApiCollection.accessTokenRenewing = true;

            ServiceXApiCollection.LOCAL_ACCESS_TOKENS.splice(0, ServiceXApiCollection.LOCAL_ACCESS_TOKENS.length)

        } else {

            for (let i = 0; i < 15; i++) {
                await delay(1500)
                if (!ServiceXApiCollection.accessTokenRenewing) break;
            }

            if (!ServiceXApiCollection.LOCAL_ACCESS_TOKENS.length) {
                ServiceXApiCollection.accessTokenRenewing = false;
                return [new Error("Erro ao renovar os acesstokens da fila", { cause: {} }), null]
            }

            ServiceXApiCollection.accessTokenRenewing = false;

            this.#updateApiInstance()

            return [null, null]

        }

        const [getAccessTokensError] = await ServiceXApiCollection.getAccessTokens()

        if (getAccessTokensError) {
            ServiceXApiCollection.accessTokenRenewing = false;
            return [getAccessTokensError, null]
        }

        this.#updateApiInstance()

        ServiceXApiCollection.accessTokenRenewing = false;

        return [null, null]

    }

    private static async getAccessTokens(): Promise<ReturnStruct<null>> {

        if (![ServiceXApiCollection.CLIENT_ID, ServiceXApiCollection.CLIENT_SECRET, ServiceXApiCollection.REFRESH_TOKEN].every((e) => !e || typeof e != 'string')) {

            return [new Error("Erro nas credenciais da collection", {
                cause: {
                    CLIENT_ID: ServiceXApiCollection.CLIENT_ID,
                    CLIENT_SECRET: ServiceXApiCollection.CLIENT_SECRET,
                    REFRESH_TOKEN: ServiceXApiCollection.REFRESH_TOKEN
                }
            }), null]

        }

        const quantity = Number(ServiceXApiCollection.ACCESS_TOKENS_QUANTITY)

        const amount = quantity && quantity > 0 ? quantity : 1;

        amount: for (let i = 0; i < amount; i++) {

            tries: for (let tries = 0; tries < 3; tries++) {

                try {

                    const { data, status } = await axios.post(`https://accounts.zoho.com/oauth/v2/token?refresh_token=${ServiceXApiCollection.REFRESH_TOKEN}&client_id=${ServiceXApiCollection.CLIENT_ID}&client_secret=${ServiceXApiCollection.CLIENT_SECRET}&grant_type=refresh_token`)

                    const newAccessToken = data?.access_token

                    if (!newAccessToken || typeof newAccessToken != 'string') {
                        return [new Error("Erro ao renovar o Access Token da Zoho.", { cause: { data, status } }), null]
                    }

                    ServiceXApiCollection.LOCAL_ACCESS_TOKENS.push(newAccessToken)

                    await delay(500);

                    break tries

                } catch (err) {
                    //  const [errorFix] = await this.errorHandler({ err, funcName, funcVars: { amount } })
                    //   if (errorFix) return [errorFix, null]
                    await delay(1500 * (tries || 1))

                }

            }

        }

        if (ServiceXApiCollection.LOCAL_ACCESS_TOKENS.length != amount) return [new Error("Erro ao gerar os novos tokens de acesso"), null]

        return [null, null]

    }

    async getRecordById(vars: { entityName: string, idRecord: string, getCache?: boolean }): Promise<ReturnStruct<any>> {

        const { name: funcName } = this.getRecordById || {}

        const { entityName, idRecord, getCache } = vars || {}

        if (!entityName || typeof entityName != 'string') {
            return [new Error("O módulo informado está inválido", { cause: { entityName } }), null]
        }

        if (!idRecord || typeof idRecord != 'string') {
            return [new Error("ID do Registro inválido.", { cause: { idRecord } }), null]
        }

        if (getCache) {

            const cache = ServiceXApiCollection.RECORDS_CACHING[entityName]?.[idRecord]

            if (cache?.id) return [null, cache]

        }

        let response: AxiosResponse<any, any> | undefined;

        for (let tries = 0; tries < 3; tries++) {

            try {

                response = await this.#api.get(`${entityName}/${idRecord}`)

                break

            } catch (err) {

                const [errorFix] = await this.errorHandler({ err, funcName, funcVars: vars })

                if (errorFix) return [errorFix, null]

                await delay(1500 * (tries || 1))

            }

        }

        if (!response) return [new Error("Limite de tentativas atingido"), null]

        const { status, data } = response || {}

        if (status != 200) {
            if (status == 204) return [null, null]
            return [new Error(`erro ao localizar a entidade ${entityName}`, { cause: data }), null]
        }

        if (!data?.id) return [new Error("erro ao localizar os dados da entidade", { cause: data }), null]

        if (getCache) {

            const entityCache = ServiceXApiCollection.RECORDS_CACHING[entityName]

            if (isObject(entityCache)) entityCache[idRecord] = data;
            else ServiceXApiCollection.RECORDS_CACHING[entityName] = { [idRecord]: data };

        }

        return [null, data]

    }

    async updateRecordById(vars: { entityName: string, idRecord: string, updateMap?: any }): Promise<ReturnStruct<any>> {

        const { name: funcName } = this.getRecordById || {}

        const { entityName, idRecord, updateMap } = vars || {}

        if (!entityName || typeof entityName != 'string') {
            return [new Error("O módulo informado está inválido", { cause: { entityName } }), null]
        }

        if (!idRecord || typeof idRecord != 'string') {
            return [new Error("ID do Registro inválido.", { cause: { idRecord } }), null]
        }

        let response: AxiosResponse<any, any> | undefined;

        for (let tries = 0; tries < 3; tries++) {

            try {

                response = await this.#api.put(`${entityName}/${idRecord}`, updateMap)

                break

            } catch (err) {

                const [errorFix] = await this.errorHandler({ err, funcName, funcVars: vars })

                if (errorFix) return [errorFix, null]

                await delay(1500 * (tries || 1))

            }

        }

        if (!response) return [new Error("Limite de tentativas atingido"), null]

        const { status, data } = response || {}

        if (status != 200) {
            return [new Error(`erro ao localizar a entidade ${entityName}`, { cause: data }), null]
        }

        return [null, null]

    }

    async createRecord(vars: { entityName: string, creationMap?: any }): Promise<ReturnStruct<any>> {

        const { name: funcName } = this.getRecordById || {}

        const { entityName, creationMap } = vars || {}

        if (!entityName || typeof entityName != 'string') {
            return [new Error("O módulo informado está inválido", { cause: { entityName } }), null]
        }

        let response: AxiosResponse<any, any> | undefined;

        for (let tries = 0; tries < 3; tries++) {

            try {

                response = await this.#api.post(`${entityName}`, creationMap)

                break

            } catch (err) {

                const [errorFix] = await this.errorHandler({ err, funcName, funcVars: vars })

                if (errorFix) return [errorFix, null]

                await delay(1500 * (tries || 1))

            }

        }

        if (!response) return [new Error("Limite de tentativas atingido"), null]

        const { status, data } = response || {}

        if (![200, 201].includes(status)) {
            return [new Error(`erro ao localizar a entidade ${entityName}`, { cause: data }), null]
        }

        return [null, null]

    }

    async findRecordOnModulesById(varsObj: {
        modulesToSearch: string[], idRecord: string,
    })
        : Promise<ReturnStruct<{ moduleName: string, data: any }>> {

        const { modulesToSearch, idRecord } = varsObj || {}

        if (!Array.isArray(modulesToSearch) || modulesToSearch.some((e) => !e || typeof e != 'string')) return [new Error("A lista de módulos para procurar está inválida", { cause: { modulesToSearch } }), null]
        if (!Number(idRecord)) return [new Error("O ID do Registro está inválido", { cause: { idRecord } }), null]

        let errorE: Error | undefined;

        for (const e of modulesToSearch) {

            await delay(200)

            const [error, data] = await this.getRecordById({ entityName: e, idRecord })

            if (error) {
                errorE = error
                continue
            }

            if (!data?.id) continue

            return [null, { moduleName: e, data: data }]

        }

        if (errorE) return [errorE, null]

        return [null, { moduleName: null, data: null }]

    }


    async errorHandler(varsObj: { err: unknown, funcName: string, funcVars: unknown })
        : Promise<ReturnStruct<null>> {

        const { funcName, err, funcVars } = varsObj || {}
        //@ts-ignore
        const { status, data } = err?.response || {}

        const message: string = typeof data?.message == "string" ? data.message : ""

        if (status == 401) {

            const [errorRenewing] = await this.renewAccessToken()

            if (errorRenewing) [errorRenewing, null]

            return [null, null]

        }

        if (["limit", "second"].every((e) => message.toLowerCase().includes(e))) {
            // embaralhar requisições
            await delay(randomNumber(1000, 7000))

            return [null, null]

        }

        return [new Error("Erro fatal não identificado na api.", { cause: err }), null]

    }

}

export default ServiceXApiCollection
