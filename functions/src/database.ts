/**
 * @file Sets up Firebase
 * @author Andreas Schjønhaug
 */

import { DocumentReference, WriteResult } from "@google-cloud/firestore"
import admin from "firebase-admin"
import * as functions from "firebase-functions"
import serializeError from "serialize-error"
import { ProgressType } from "./enums"
import { IParagraph, ITranscript } from "./interfaces"
// Only initialise the app once
if (!admin.apps.length) {
  admin.initializeApp(functions.config().firebase)
} else {
  admin.app()
}

const db = admin.firestore()

const database = (() => {
  const updateTranscript = async (id: string, transcript: ITranscript): Promise<FirebaseFirestore.WriteResult> => {
    return db.doc(`transcripts/${id}`).set({ ...transcript }, { merge: true })
  }

  const setProgress = async (transcriptId: string, progress: ProgressType): Promise<FirebaseFirestore.WriteResult> => {
    const transcript: ITranscript = { status: { progress } }

    if (progress === ProgressType.Analysing || progress === ProgressType.Saving) {
      transcript.status!.percent = 0
    } else if (progress === ProgressType.Done) {
      transcript.status!.percent = admin.firestore.FieldValue.delete()
    }

    return updateTranscript(transcriptId, transcript)
  }

  const setPercent = async (transcriptId: string, percent: number): Promise<FirebaseFirestore.WriteResult> => {
    const transcript: ITranscript = { status: { percent } }

    return updateTranscript(transcriptId, transcript)
  }

  const addParagraph = async (transcriptId: string, paragraph: IParagraph, percent: number) => {
    // Batch
    const batch = db.batch()

    // Add paragraph
    const paragraphsRef = `transcripts/${transcriptId}/paragraphs`
    const paragraphId = db.collection(paragraphsRef).doc().id

    const paragraphReference = db.doc(`${paragraphsRef}/${paragraphId}`)

    batch.create(paragraphReference, paragraph)

    // Set percent
    const transcriptReference = db.doc(`transcripts/${transcriptId}`)
    batch.update(transcriptReference, { "status.percent": percent })

    // Commit
    return batch.commit()
  }

  const setDuration = async (transcriptId: string, seconds: number): Promise<FirebaseFirestore.WriteResult> => {
    const transcript: ITranscript = { metadata: { audioDuration: seconds } }

    return updateTranscript(transcriptId, transcript)
  }

  const errorOccured = async (transcriptId: string, error: Error): Promise<FirebaseFirestore.WriteResult> => {
    const serializedError = serializeError(error)

    // Firestore does not support undefined values, remove them if present.
    Object.keys(serializedError).forEach(key => serializedError[key] === undefined && delete serializedError[key])

    const transcript: ITranscript = {
      status: {
        error: serializedError,
      },
    }
    return updateTranscript(transcriptId, transcript)
  }

  const getParagraphs = async (transcriptId: string): Promise<IParagraph[]> => {
    const querySnapshot = await db
      .collection(`transcripts/${transcriptId}/paragraphs`)
      .orderBy("startTime")
      .get()

    const paragraphs = Array<IParagraph>()

    querySnapshot.forEach(doc => {
      const paragraph = doc.data() as IParagraph

      paragraphs.push(paragraph)
    })

    return paragraphs
  }

  const getProgress = async (id: string): Promise<ProgressType> => {
    const doc = await db.doc(`transcripts/${id}`).get()

    const transcript = doc.data() as ITranscript

    return transcript.status.progress
  }

  const setPlaybackGsUrl = async (id: string, url: string) => {
    const transcript: ITranscript = { playbackGsUrl: url }

    return updateTranscript(id, transcript)
  }

  const getTranscript = async (transcriptId: string): Promise<ITranscript> => {
    const doc = await db.doc(`transcripts/${transcriptId}`).get()

    return doc.data() as ITranscript
  }

  const deleteTranscript = async (transcriptId: string): Promise<WriteResult> => {
    // Delete the paragraphs collection
    const paragraphsPath = `/transcripts/${transcriptId}/paragraphs`

    await deleteCollection(paragraphsPath, 10)

    // Delete the document
    return db.doc(`transcripts/${transcriptId}`).delete()
  }

  const deleteCollection = async (collectionPath: string, batchSize: number): Promise<{}> => {
    const collectionRef = db.collection(collectionPath)
    const query = collectionRef.orderBy("__name__").limit(batchSize)

    return new Promise((resolve, reject) => {
      deleteQueryBatch(query, batchSize, resolve, reject)
    })
  }

  const deleteQueryBatch = (query: FirebaseFirestore.Query, batchSize: number, resolve, reject) => {
    query
      .get()
      .then(snapshot => {
        // When there are no documents left, we are done
        if (snapshot.size === 0) {
          return 0
        }

        // Delete documents in a batch
        const batch = db.batch()
        snapshot.docs.forEach(doc => {
          batch.delete(doc.ref)
        })

        return batch.commit().then(() => {
          return snapshot.size
        })
      })
      .then((numDeleted: number) => {
        if (numDeleted === 0) {
          resolve()
          return
        }

        // Recurse on the next process tick, to avoid
        // exploding the stack.
        process.nextTick(() => {
          deleteQueryBatch(query, batchSize, resolve, reject)
        })
      })
      .catch(reject)
  }

  const getTranscripts = async (): Promise => {
    const querySnapshot = await db.collection(`transcripts/`).get()

    const transcripts: { [k: string]: ITranscript } = {}
    querySnapshot.forEach(doc => {
      const id = doc.id
      const transcript = doc.data() as ITranscript

      transcripts[doc.id] = transcript
    })

    return transcripts
  }

  return {
    addParagraph,
    deleteTranscript,
    errorOccured,
    getParagraphs,
    getProgress,
    getTranscript,
    getTranscripts,
    setDuration,
    setPercent,
    setPlaybackGsUrl,
    setProgress,
  }
})()

export default database
