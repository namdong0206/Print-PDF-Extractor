import * as admin from 'firebase-admin';
import firebaseConfig from '../firebase-applet-config.json';

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

export const dbAdmin = admin.firestore(firebaseConfig.firestoreDatabaseId);
export const authAdmin = admin.auth();
